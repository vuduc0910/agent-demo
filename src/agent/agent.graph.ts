import {
  Command,
  END,
  interrupt,
  START,
  StateGraph,
} from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ActionExecutorService,
  ActionPayload,
} from '../actions/action-executor.service.js';
import {
  ActionRequest,
  evaluatePolicy,
  PolicyDecisionKind,
  RENEWAL_REFUND_WINDOW_DAYS,
} from '../actions/action-policy.js';
import { AuditService } from '../audit/audit.service.js';
import { CommerceService } from '../commerce/commerce.service.js';
import type { Env } from '../config/env.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TicketsService } from '../tickets/tickets.service.js';
import type { IssueAnalysis } from './agent.schemas.js';
import {
  AgentState,
  AgentStateUpdate,
  AgentStateValue,
  ApprovalResult,
  SecurityResult,
} from './agent.state.js';
import {
  formatTranscript,
  pickOrderReference,
  validateTicket,
} from './input-validation.js';
import { formatUsd, unmatchedAmounts } from './claims.js';
import { LlmService } from './llm.service.js';
import { replyViolation } from './reply-guard.js';
import { detectInjection, maxRisk } from './security-heuristics.js';

type Node = (s: AgentStateValue) => Promise<AgentStateUpdate>;

const MIN_CLASSIFICATION_CONFIDENCE = 0.5;

const ACTION_STATUS = {
  ALLOW: 'authorized',
  REQUIRE_APPROVAL: 'pending_approval',
  DENY: 'denied',
} as const satisfies Record<PolicyDecisionKind, string>;

const POLICY_EVENT = {
  ALLOW: 'policy_allowed',
  REQUIRE_APPROVAL: 'policy_requires_approval',
  DENY: 'policy_denied',
} as const satisfies Record<PolicyDecisionKind, string>;

const ACCOUNT_ASK = 'the email address on your account or your order number';
const ASK: Record<string, string | null> = {
  TICKET_RESOLVED: null,
  EMPTY_MESSAGE: 'a short description of the problem',
  MESSAGE_TOO_LONG: 'a shorter summary of the problem',
  CUSTOMER_ID_MISSING: ACCOUNT_ASK,
  CUSTOMER_ID_INVALID: ACCOUNT_ASK,
  CUSTOMER_NOT_FOUND: ACCOUNT_ASK,
  INVALID_ORDER_REFERENCE:
    'your order number exactly as it appears in your confirmation email',
  UNCLEAR_REQUEST:
    'a few more details about what went wrong (and your order number if it is about an order)',
};

const firstName = (s: AgentStateValue) =>
  s.customer?.name.split(' ')[0] ?? 'there';

const isOffTopic = (issue?: IssueAnalysis) => issue?.issue_type === 'off_topic';

const rejectEarly = (s: AgentStateValue) =>
  !!s.security?.prompt_injection_detected &&
  !s.security.genuine_support_request &&
  !s.validation?.orderReferences.length;

const unmatchedClaims = (s: AgentStateValue) =>
  s.context
    ? unmatchedAmounts(s.validation?.claimedAmounts ?? [], s.context)
    : [];

const noMatchingOrder = (s: AgentStateValue) =>
  !s.issue?.order_reference && unmatchedClaims(s).length > 0;

const needsClarification = (issue?: IssueAnalysis) =>
  !issue ||
  issue.issue_type === 'unclear' ||
  issue.confidence < MIN_CLASSIFICATION_CONFIDENCE;

const orderMissing = (s: AgentStateValue) =>
  !!s.context?.referencedOrderId && !s.context.referencedOrderFound;

@Injectable()
export class AgentGraphService implements OnModuleInit, OnModuleDestroy {
  private checkpointer!: PostgresSaver;
  private graph!: ReturnType<AgentGraphService['build']>;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly tickets: TicketsService,
    private readonly commerce: CommerceService,
    private readonly executor: ActionExecutorService,
    private readonly audit: AuditService,
    private readonly llm: LlmService,
  ) {}

  async onModuleInit() {
    this.checkpointer = PostgresSaver.fromConnString(
      this.config.get('DATABASE_URL', { infer: true }),
      { schema: 'langgraph' },
    );
    await this.checkpointer.setup();
    this.graph = this.build();
  }

  async onModuleDestroy() {
    await this.checkpointer.end();
  }

  start(runId: string, input: AgentStateUpdate) {
    return this.graph.invoke(input, { configurable: { thread_id: runId } });
  }

  resume(runId: string, approval: ApprovalResult) {
    return this.graph.invoke(new Command({ resume: approval }), {
      configurable: { thread_id: runId },
    });
  }

  getState(runId: string) {
    return this.graph.getState({ configurable: { thread_id: runId } });
  }

  private build() {
    return new StateGraph(AgentState)
      .addNode('load_ticket', this.loadTicket)
      .addNode('validate_input', this.validateInput)
      .addNode('request_info', this.requestInfo)
      .addNode('security_check', this.securityCheck)
      .addNode('security_block', this.securityBlock)
      .addNode('classify_issue', this.classifyIssue)
      .addNode('retrieve_trusted_data', this.retrieveTrustedData)
      .addNode('analyze_issue', this.analyzeIssue)
      .addNode('propose_action', this.proposeAction)
      .addNode('policy_engine', this.policyEngine)
      .addNode('human_review', this.humanReview)
      .addNode('blocked', this.blocked)
      .addNode('execute_action', this.executeAction)
      .addNode('verify_execution', this.verifyExecution)
      .addNode('generate_response', this.generateResponse)
      .addNode('audit_log', this.auditLog)
      .addEdge(START, 'load_ticket')
      .addConditionalEdges(
        'load_ticket',
        (s) => (s.ticket ? 'validate_input' : 'audit_log'),
        ['validate_input', 'audit_log'],
      )
      .addConditionalEdges(
        'validate_input',
        (s) => (s.validation?.valid ? 'security_check' : 'request_info'),
        ['security_check', 'request_info'],
      )
      .addEdge('request_info', 'audit_log')
      .addConditionalEdges(
        'security_check',
        (s) => (rejectEarly(s) ? 'security_block' : 'classify_issue'),
        ['security_block', 'classify_issue'],
      )
      .addEdge('security_block', 'audit_log')
      .addConditionalEdges(
        'classify_issue',
        (s) => (isOffTopic(s.issue) ? 'request_info' : 'retrieve_trusted_data'),
        ['request_info', 'retrieve_trusted_data'],
      )
      .addConditionalEdges(
        'retrieve_trusted_data',
        (s) =>
          orderMissing(s) || noMatchingOrder(s) || needsClarification(s.issue)
            ? 'request_info'
            : 'analyze_issue',
        ['request_info', 'analyze_issue'],
      )
      .addEdge('analyze_issue', 'propose_action')
      .addEdge('propose_action', 'policy_engine')
      .addConditionalEdges(
        'policy_engine',
        (s) =>
          (
            ({
              ALLOW: 'execute_action',
              REQUIRE_APPROVAL: 'human_review',
              DENY: 'blocked',
            }) as const
          )[s.policyDecision?.decision ?? 'DENY'],
        ['execute_action', 'human_review', 'blocked'],
      )
      .addConditionalEdges(
        'human_review',
        (s) => (s.approval?.approved ? 'execute_action' : 'generate_response'),
        ['execute_action', 'generate_response'],
      )
      .addEdge('blocked', 'generate_response')
      .addEdge('execute_action', 'verify_execution')
      .addEdge('verify_execution', 'generate_response')
      .addEdge('generate_response', 'audit_log')
      .addEdge('audit_log', END)
      .compile({ checkpointer: this.checkpointer });
  }

  private loadTicket: Node = async (s) => {
    await this.audit.log(s.runId, 'ticket_received', { ticketId: s.ticketId });
    const ticket = await this.tickets.findFacts(s.ticketId);
    if (ticket) return { ticket };
    await this.audit.log(s.runId, 'ticket_not_found', { ticketId: s.ticketId });
    return {
      outcome: 'failed',
      errors: [
        {
          node: 'load_ticket',
          code: 'TICKET_NOT_FOUND',
          message: `Ticket ${s.ticketId} not found`,
        },
      ],
    };
  };

  private validateInput: Node = async (s) => {
    const ticket = s.ticket!;
    const customer = ticket.customerId
      ? await this.commerce.findCustomer(ticket.customerId)
      : null;
    const validation = validateTicket(ticket, !!customer);
    await this.audit.log(
      s.runId,
      validation.valid ? 'validation_passed' : 'validation_failed',
      {
        errors: validation.errors,
        orderReferences: validation.orderReferences,
      },
    );
    return {
      validation,
      customer: customer ?? undefined,
      errors: validation.errors.map((e) => ({ node: 'validate_input', ...e })),
    };
  };

  private requestInfo: Node = async (s) => {
    if (s.validation?.valid && isOffTopic(s.issue)) {
      await this.audit.log(s.runId, 'request_out_of_scope', {
        intent: s.issue?.customer_intent,
      });
      return {
        outcome: 'blocked',
        errors: [
          {
            node: 'request_info',
            code: 'OUT_OF_SCOPE',
            message: 'request is outside customer-support scope',
          },
        ],
        customerResponse: [
          `Hi ${firstName(s)},`,
          '',
          'I can only help with your orders, deliveries, payments, subscriptions and account. Is there anything along those lines I can help you with?',
          '',
          'Customer Support Team',
        ].join('\n'),
      };
    }
    const codes = !s.validation?.valid
      ? (s.validation?.errors.map((e) => e.code) ?? [])
      : [
          ...(orderMissing(s) ? ['ORDER_NOT_FOUND'] : []),
          ...(noMatchingOrder(s) ? ['NO_MATCHING_ORDER'] : []),
          ...(needsClarification(s.issue) ? ['UNCLEAR_REQUEST'] : []),
        ];
    const asks = [
      ...new Set(
        codes.map((c) =>
          c === 'ORDER_NOT_FOUND'
            ? `the correct order number (we couldn't find order #${s.issue?.order_reference} on your account)`
            : c === 'NO_MATCHING_ORDER'
              ? `your order number (we couldn't find an order on your account matching ${unmatchedClaims(s).map(formatUsd).join(', ')})`
              : ASK[c],
        ),
      ),
    ].filter((a): a is string => !!a);

    await this.audit.log(s.runId, 'request_info', { codes });
    const errors = s.validation?.valid
      ? codes.map((code) => ({
          node: 'request_info',
          code,
          message: code.toLowerCase(),
        }))
      : [];
    if (!asks.length) return { outcome: 'blocked', errors };
    return {
      outcome: 'needs_info',
      errors,
      customerResponse: [
        `Hi ${firstName(s)},`,
        '',
        'Thanks for reaching out. So we can help, could you please send us:',
        ...asks.map((a) => `- ${a}`),
        '',
        'Customer Support Team',
      ].join('\n'),
    };
  };

  private securityCheck: Node = async (s) => {
    const heuristics = detectInjection(
      formatTranscript(s.ticket!.turns.filter((t) => t.author === 'customer')),
    );
    const llm = await this.llm.assessSecurity(s.validation!.transcript);
    const security: SecurityResult = {
      risk: maxRisk(heuristics.risk, llm.risk),
      prompt_injection_detected:
        heuristics.patterns.length > 0 || llm.prompt_injection_detected,
      patterns: [...new Set([...heuristics.patterns, ...llm.patterns])],
      heuristic_patterns: heuristics.patterns,
      genuine_support_request: llm.genuine_support_request,
      llm_explanation: llm.explanation,
    };
    await this.audit.log(
      s.runId,
      security.prompt_injection_detected
        ? 'prompt_injection_detected'
        : 'security_check_passed',
      { risk: security.risk, patterns: security.patterns },
    );
    return { security };
  };

  private securityBlock: Node = async (s) => {
    await this.audit.log(s.runId, 'request_rejected_security', {
      risk: s.security?.risk,
      patterns: s.security?.patterns,
    });
    return {
      outcome: 'blocked',
      errors: [
        {
          node: 'security_block',
          code: 'MANIPULATION_WITHOUT_SUPPORT_REQUEST',
          message: 'manipulation attempt with no genuine support request',
        },
      ],
      customerResponse: [
        `Hi ${firstName(s)},`,
        '',
        "We couldn't find an order on your account that matches this request. Could you reply with your order number, as shown in your confirmation email, so we can look into it?",
        '',
        'Customer Support Team',
      ].join('\n'),
    };
  };

  private classifyIssue: Node = async (s) => {
    const raw = await this.llm.classify(s.validation!.transcript);
    const issue = {
      ...raw,
      order_reference: pickOrderReference(raw.order_reference, s.validation!),
    };
    await this.audit.log(s.runId, `classified_${issue.issue_type}`, {
      category: issue.category,
      severity: issue.severity,
      confidence: issue.confidence,
      order_reference: issue.order_reference,
      llm_order_reference: raw.order_reference,
    });
    return { issue };
  };

  private retrieveTrustedData: Node = async (s) => {
    const context = await this.commerce.getTrustedContext(
      s.customer!,
      s.issue!.order_reference,
    );
    await this.audit.log(s.runId, 'context_retrieved', {
      orders: context.orders.map((o) => o.id),
      payments: context.payments.map((p) => p.id),
      subscriptions: context.subscriptions.map((x) => x.id),
      claimedAmounts: s.validation?.claimedAmounts,
      unmatchedClaims: unmatchedClaims({ ...s, context }),
    });
    if (orderMissing({ ...s, context }))
      await this.audit.log(s.runId, 'referenced_order_not_found', {
        orderId: context.referencedOrderId,
      });
    return { context };
  };

  private analyzeIssue: Node = async (s) => {
    const context = s.context!;
    const raw = await this.llm.analyze(
      s.validation!.transcript,
      s.issue!,
      context,
    );
    const known = new Set([
      ...context.orders.map((o) => o.id),
      ...context.payments.map((p) => p.id),
      ...context.subscriptions.map((x) => x.id),
    ]);
    const analysis = {
      ...raw,
      evidence_ids: raw.evidence_ids.filter((id) => known.has(id)),
    };
    await this.audit.log(
      s.runId,
      `${s.issue!.issue_type}_${analysis.issue_confirmed ? 'confirmed' : 'not_confirmed'}`,
      {
        finding: analysis.finding,
        confidence: analysis.confidence,
        evidence: analysis.evidence_ids,
      },
    );
    return { analysis };
  };

  private proposeAction: Node = async (s) => {
    const proposedAction = await this.llm.propose(
      s.issue!,
      s.analysis!,
      s.context!,
      s.validation!.transcript,
    );
    await this.audit.log(s.runId, `${proposedAction.action}_proposed`, {
      target_id: proposedAction.target_id,
      reason: proposedAction.reason,
    });
    return { proposedAction };
  };

  private policyEngine: Node = async (s) => {
    const p = s.proposedAction!;
    const ctx = s.context!;
    const request: ActionRequest = {
      action: p.action,
      targetId: p.target_id,
      newShippingAddress: p.new_shipping_address,
      tag: p.tag,
      notificationMessage: p.notification_message,
    };
    const policyDecision = evaluatePolicy(request, {
      orderIds: ctx.orders.map((o) => o.id),
      paymentIds: ctx.payments.map((x) => x.id),
      subscriptionIds: ctx.subscriptions.map((x) => x.id),
      refundableSubscriptionIds: ctx.subscriptions
        .filter((x) => x.renewalRefundEligible)
        .map((x) => x.id),
      promptInjectionDetected: !!s.security?.prompt_injection_detected,
      claimedAmountMismatch: unmatchedClaims(s).length > 0,
      customerRiskLevel: s.customer!.riskLevel,
    });
    const payload: ActionPayload = {
      ...request,
      ticketId: s.ticket!.id,
      customerId: s.customer!.id,
    };
    const action = await this.prisma.agentAction.create({
      data: {
        agentRunId: s.runId,
        actionType: p.action,
        riskLevel: policyDecision.riskLevel,
        status: ACTION_STATUS[policyDecision.decision],
        payload,
        approval:
          policyDecision.decision === 'REQUIRE_APPROVAL'
            ? { create: { agentRunId: s.runId } }
            : undefined,
      },
    });
    await this.audit.log(s.runId, POLICY_EVENT[policyDecision.decision], {
      actionId: action.id,
      action: p.action,
      reason: policyDecision.reason,
      flags: policyDecision.flags,
    });
    return { policyDecision, actionId: action.id };
  };

  private humanReview: Node = async (s) => {
    const approval = interrupt<object, ApprovalResult>({
      actionId: s.actionId,
      action: s.proposedAction?.action,
      reason: s.policyDecision?.reason,
    });
    return approval.approved ? { approval } : { approval, outcome: 'rejected' };
  };

  private blocked: Node = async (s) => {
    await this.audit.log(s.runId, 'action_blocked', {
      action: s.proposedAction?.action,
      reason: s.policyDecision?.reason,
    });
    return { outcome: 'blocked' };
  };

  private executeAction: Node = async (s) => {
    const executionResult = await this.executor.execute(s.actionId!);
    await this.audit.log(
      s.runId,
      executionResult.success
        ? `${s.proposedAction!.action}_simulated`
        : 'execution_failed',
      executionResult,
    );
    return { executionResult };
  };

  private verifyExecution: Node = async (s) => {
    const verification = await this.executor.verify(s.actionId!);
    await this.audit.log(
      s.runId,
      verification.verified ? 'execution_verified' : 'execution_not_verified',
      verification,
    );
    const outcome = !s.executionResult?.success
      ? 'blocked'
      : verification.verified
        ? 'completed'
        : 'failed';
    return { verification, outcome };
  };

  private generateResponse: Node = async (s) => {
    const context = s.context!;
    const facts = {
      customer_first_name: firstName(s),
      outcome: s.outcome,
      issue_type: s.issue?.issue_type,
      verified_finding: s.analysis?.finding,
      action: s.proposedAction?.action,
      execution: s.executionResult ?? null,
      verified: s.verification?.verified ?? false,
      orders: context.orders.map((o) => ({
        number: o.id.replace('ord_', '#'),
        status: o.status,
        carrier: o.carrier,
        tracking_number: o.trackingNumber,
        delivered_at: o.deliveredAt,
        shipping_address: o.shippingAddress,
      })),
      subscriptions: context.subscriptions.map((x) => ({
        plan: x.plan,
        status: x.status,
        auto_renew: x.status === 'active' && !x.cancelAtPeriodEnd,
        current_period_end: x.currentPeriodEnd,
        latest_charge: x.latestCharge && {
          amount: x.latestCharge.amount,
          currency: x.latestCharge.currency,
          status: x.latestCharge.status,
          charged_at: x.latestCharge.capturedAt,
        },
        renewal_refund_eligible: x.renewalRefundEligible,
      })),
      renewal_refund_window_days: RENEWAL_REFUND_WINDOW_DAYS,
    };
    let customerResponse = await this.llm.writeReply(facts);
    const violation = replyViolation(customerResponse, s.outcome);
    if (violation) {
      await this.audit.log(s.runId, 'response_guard_triggered', {
        outcome: s.outcome,
        violation,
      });
      customerResponse = [
        `Hi ${firstName(s)},`,
        '',
        "Thanks for reaching out. We've reviewed your request and passed it to our team, who will confirm the next step shortly.",
        '',
        'Customer Support Team',
      ].join('\n');
    }
    await this.audit.log(s.runId, 'customer_response_generated');
    return { customerResponse };
  };

  private auditLog: Node = async (s) => {
    const outcome = s.outcome ?? 'failed';
    if (s.ticket && s.customerResponse)
      await this.tickets.addMessage(
        s.ticket.id,
        'agent',
        s.customerResponse,
        s.runId,
      );
    await this.prisma.agentRun.update({
      where: { id: s.runId },
      data: {
        status: outcome,
        completedAt: new Date(),
        error: outcome === 'failed' ? (s.errors.at(-1)?.code ?? null) : null,
      },
    });
    await this.audit.log(s.runId, 'run_finished', { outcome });
    return {};
  };
}
