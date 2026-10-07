import {
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AgentService } from '../agent/agent.service.js';
import { CommerceService } from '../commerce/commerce.service.js';
import { TicketsService } from '../tickets/tickets.service.js';

export const CONVERSATION_IDLE_TIMEOUT_MS = 30 * 60_000;

@Injectable()
export class ChatService {
  constructor(
    private readonly tickets: TicketsService,
    private readonly agent: AgentService,
    private readonly commerce: CommerceService,
  ) {}

  customers() {
    return this.commerce.listCustomers();
  }

  async start(customerId: string | null, message: string) {
    const ticket = await this.tickets.createTicket(customerId, message);
    const run = await this.agent.startRun(ticket.id);
    return { ticketId: ticket.id, runId: run.id };
  }

  async send(ticketId: string, message: string) {
    const conversation = await this.get(ticketId);
    if (conversation.activeRun)
      throw new ConflictException(
        "We're still working on your previous message.",
      );
    if (conversation.expired)
      throw new GoneException(
        'This conversation has expired. Please start a new one.',
      );
    await this.tickets.addMessage(ticketId, 'customer', message);
    const run = await this.agent.startRun(ticketId);
    return { ticketId, runId: run.id };
  }

  async get(ticketId: string) {
    const conversation = await this.tickets.conversation(ticketId);
    if (!conversation)
      throw new NotFoundException(`Conversation ${ticketId} not found`);
    const activeRun = await this.agent.activeRun(ticketId);
    const lastMessageAt = Math.max(
      ...conversation.messages.map((m) => new Date(m.createdAt).getTime()),
    );
    const expiresAt = activeRun
      ? null
      : new Date(lastMessageAt + CONVERSATION_IDLE_TIMEOUT_MS);
    return {
      ...conversation,
      activeRun,
      expiresAt,
      expired: !!expiresAt && expiresAt.getTime() <= Date.now(),
    };
  }
}
