import { ReducedValue, StateSchema } from '@langchain/langgraph';
import { z } from 'zod';
import type {
  ExecutionResult,
  VerificationResult,
} from '../actions/action-executor.service.js';
import type { PolicyDecision } from '../actions/action-policy.js';
import type {
  CustomerFacts,
  TrustedContext,
} from '../commerce/commerce.service.js';
import type { TicketFacts } from '../tickets/tickets.service.js';
import {
  AnalysisSchema,
  IssueSchema,
  ProposedActionSchema,
} from './agent.schemas.js';
import type { ValidationResult } from './input-validation.js';
import type { RiskLevel, SecurityPattern } from './security-heuristics.js';

export interface SecurityResult {
  risk: RiskLevel;
  prompt_injection_detected: boolean;
  patterns: SecurityPattern[];
  heuristic_patterns: SecurityPattern[];
  genuine_support_request: boolean;
  llm_explanation: string;
}

export interface ApprovalResult {
  approved: boolean;
  reviewer: string;
  reason?: string;
}

export interface AgentError {
  node: string;
  code: string;
  message: string;
}

export const RUN_OUTCOMES = [
  'completed',
  'needs_info',
  'blocked',
  'rejected',
  'failed',
] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export const AgentState = new StateSchema({
  runId: z.string(),
  ticketId: z.string(),
  ticket: z.custom<TicketFacts>().optional(),
  customer: z.custom<CustomerFacts>().optional(),
  validation: z.custom<ValidationResult>().optional(),
  security: z.custom<SecurityResult>().optional(),
  issue: IssueSchema.optional(),
  context: z.custom<TrustedContext>().optional(),
  analysis: AnalysisSchema.optional(),
  proposedAction: ProposedActionSchema.optional(),
  policyDecision: z.custom<PolicyDecision>().optional(),
  actionId: z.string().optional(),
  approval: z.custom<ApprovalResult>().optional(),
  executionResult: z.custom<ExecutionResult>().optional(),
  verification: z.custom<VerificationResult>().optional(),
  outcome: z.enum(RUN_OUTCOMES).optional(),
  customerResponse: z.string().optional(),
  errors: new ReducedValue(
    z.array(z.custom<AgentError>()).default(() => []),
    {
      reducer: (current, next) => current.concat(next),
    },
  ),
});

export type AgentStateValue = typeof AgentState.State;
export type AgentStateUpdate = typeof AgentState.Update;
