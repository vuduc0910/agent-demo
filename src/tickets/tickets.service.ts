import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Turn } from '../agent/input-validation.js';
import type { MessageAuthor } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface TicketFacts {
  id: string;
  customerId: string | null;
  subject: string;
  turns: Turn[];
  status: string;
  tags: string[];
}

const RECENT_MESSAGES = 4;

@Injectable()
export class TicketsService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const [tickets, customers, runs] = await Promise.all([
      this.prisma.supportTicket.findMany({
        orderBy: { createdAt: 'desc' },
        include: { messages: { orderBy: { id: 'asc' } } },
      }),
      this.prisma.customer.findMany({ select: { id: true, name: true } }),
      this.prisma.agentRun.findMany({
        distinct: ['ticketId'],
        orderBy: [{ ticketId: 'asc' }, { startedAt: 'desc' }],
        select: { id: true, ticketId: true, status: true },
      }),
    ]);
    const names = new Map(customers.map((c) => [c.id, c.name]));
    const lastRun = new Map(runs.map((r) => [r.ticketId, r]));
    return tickets.map((t) => ({
      ...t,
      customerName: (t.customerId && names.get(t.customerId)) ?? null,
      lastRun: lastRun.get(t.id) ?? null,
    }));
  }

  async findFacts(id: string): Promise<TicketFacts | null> {
    const t = await this.prisma.supportTicket.findUnique({
      where: { id },
      include: { messages: { orderBy: { id: 'asc' } } },
    });
    if (!t) return null;
    return {
      id: t.id,
      customerId: t.customerId,
      subject: t.subject,
      turns: [
        { author: 'customer', body: t.message },
        ...t.messages
          .slice(-RECENT_MESSAGES)
          .map(({ author, body }) => ({ author, body })),
      ],
      status: t.status,
      tags: t.tags,
    };
  }

  createTicket(customerId: string | null, message: string) {
    return this.prisma.supportTicket.create({
      data: {
        id: `chat_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
        customerId,
        subject: message.slice(0, 60),
        message,
        createdAt: new Date(),
      },
    });
  }

  addMessage(
    ticketId: string,
    author: MessageAuthor,
    body: string,
    agentRunId?: string,
  ) {
    return this.prisma.ticketMessage.create({
      data: { ticketId, author, body, agentRunId },
    });
  }

  async conversation(id: string) {
    const t = await this.prisma.supportTicket.findUnique({
      where: { id },
      include: { messages: { orderBy: { id: 'asc' } } },
    });
    if (!t) return null;
    return {
      id: t.id,
      customerId: t.customerId,
      messages: [
        { id: 0, author: 'customer', body: t.message, createdAt: t.createdAt },
        ...t.messages.map(({ id, author, body, createdAt }) => ({
          id,
          author,
          body,
          createdAt,
        })),
      ],
    };
  }
}
