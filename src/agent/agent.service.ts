import { isInterrupted } from '@langchain/langgraph';
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TicketsService } from '../tickets/tickets.service.js';
import { AgentGraphService } from './agent.graph.js';
import type { ApprovalDecisionDto } from './agent.schemas.js';
import type { ApprovalResult } from './agent.state.js';

const REVIEW_NOTICE =
  "Thanks for your patience. This request needs a quick review by our team, and we'll reply here as soon as it's done.";
const FAILURE_NOTICE =
  'Sorry, something went wrong on our side. A team member will look into your request and follow up here.';

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: AgentGraphService,
    private readonly audit: AuditService,
    private readonly tickets: TicketsService,
  ) {}

  async startRun(ticketId: string) {
    const run = await this.prisma.agentRun.create({ data: { ticketId } });
    this.drive(run.id, this.graph.start(run.id, { runId: run.id, ticketId }));
    return run;
  }

  activeRun(ticketId: string) {
    return this.prisma.agentRun.findFirst({
      where: { ticketId, status: { in: ['running', 'awaiting_approval'] } },
      orderBy: { startedAt: 'desc' },
      select: { id: true, status: true },
    });
  }

  listRuns(ticketId?: string) {
    return this.prisma.agentRun.findMany({
      where: { ticketId },
      orderBy: { startedAt: 'desc' },
      take: 20,
    });
  }

  async getRun(id: string) {
    const run = await this.prisma.agentRun.findUnique({
      where: { id },
      include: {
        actions: { include: { approval: true }, orderBy: { createdAt: 'asc' } },
        auditLogs: { orderBy: { id: 'asc' } },
      },
    });
    if (!run) throw new NotFoundException(`Agent run ${id} not found`);
    const snapshot = await this.graph.getState(id);
    return { ...run, state: snapshot.values, next: snapshot.next };
  }

  async decide(runId: string, dto: ApprovalDecisionDto) {
    const approved = dto.decision === 'approve';
    const approval = await this.prisma.$transaction(async (tx) => {
      const pending = await tx.approvalRequest.findFirst({
        where: { agentRunId: runId, status: 'pending' },
      });
      if (!pending)
        throw new ConflictException('No pending approval for this run.');
      const { count } = await tx.approvalRequest.updateMany({
        where: { id: pending.id, status: 'pending' },
        data: {
          status: approved ? 'approved' : 'rejected',
          approvedBy: dto.reviewer,
          approvedAt: new Date(),
          reason: dto.reason,
        },
      });
      if (!count) throw new ConflictException('Approval was already decided.');
      await tx.agentAction.update({
        where: { id: pending.actionId },
        data: { status: approved ? 'approved' : 'rejected' },
      });
      await tx.agentRun.update({
        where: { id: runId },
        data: { status: 'running' },
      });
      return pending;
    });
    await this.audit.log(
      runId,
      approved ? 'human_approved' : 'human_rejected',
      {
        reviewer: dto.reviewer,
        reason: dto.reason,
        actionId: approval.actionId,
      },
    );
    const resume: ApprovalResult = {
      approved,
      reviewer: dto.reviewer,
      reason: dto.reason,
    };
    this.drive(runId, this.graph.resume(runId, resume));
    return { runId, status: 'running' };
  }

  private async ticketOf(runId: string) {
    const run = await this.prisma.agentRun.findUniqueOrThrow({
      where: { id: runId },
      select: { ticketId: true },
    });
    return run.ticketId;
  }

  private drive(runId: string, execution: Promise<unknown>) {
    execution
      .then(async (result) => {
        if (!isInterrupted(result)) return;
        await this.tickets.addMessage(
          await this.ticketOf(runId),
          'agent',
          REVIEW_NOTICE,
          runId,
        );
        await this.prisma.agentRun.update({
          where: { id: runId },
          data: { status: 'awaiting_approval' },
        });
        await this.audit.log(runId, 'awaiting_human_approval');
      })
      .catch(async (err: unknown) => {
        this.logger.error(`Agent run ${runId} failed`, err);
        const error = err instanceof Error ? err.message : String(err);
        await this.tickets.addMessage(
          await this.ticketOf(runId),
          'agent',
          FAILURE_NOTICE,
          runId,
        );
        await this.prisma.agentRun.update({
          where: { id: runId },
          data: { status: 'failed', error, completedAt: new Date() },
        });
        await this.audit.log(runId, 'run_failed', { error });
      })
      .catch((err: unknown) => this.logger.error(err));
  }
}
