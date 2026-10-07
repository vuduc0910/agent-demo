import { ConflictException, GoneException } from '@nestjs/common';
import type { AgentService } from '../agent/agent.service.js';
import type { CommerceService } from '../commerce/commerce.service.js';
import type { TicketsService } from '../tickets/tickets.service.js';
import { ChatService, CONVERSATION_IDLE_TIMEOUT_MS } from './chat.service.js';

describe('ChatService conversation session', () => {
  const now = new Date('2026-10-07T10:00:00Z').getTime();
  const minutesAgo = (m: number) => new Date(now - m * 60_000);
  let activeRun: { id: string; status: string } | null;
  let messages: { author: string; body: string; createdAt: Date }[];
  const tickets = {
    conversation: vi.fn(() =>
      Promise.resolve({ id: 'chat_x', customerId: 'cus_001', messages }),
    ),
    addMessage: vi.fn(() => Promise.resolve()),
  };
  const agent = {
    activeRun: vi.fn(() => Promise.resolve(activeRun)),
    startRun: vi.fn(() => Promise.resolve({ id: 'run_x' })),
  };
  const chat = new ChatService(
    tickets as unknown as TicketsService,
    agent as unknown as AgentService,
    {} as CommerceService,
  );

  beforeEach(() => {
    vi.useFakeTimers({ now });
    vi.clearAllMocks();
    activeRun = null;
    messages = [
      { author: 'customer', body: 'Cancel my sub', createdAt: minutesAgo(50) },
      { author: 'agent', body: 'Which one?', createdAt: minutesAgo(29) },
    ];
  });

  afterEach(() => vi.useRealTimers());

  it('stays open for 30 minutes after the last message, whoever sent it', async () => {
    const c = await chat.get('chat_x');
    expect(c.expired).toBe(false);
    expect(c.expiresAt?.getTime()).toBe(
      minutesAgo(29).getTime() + CONVERSATION_IDLE_TIMEOUT_MS,
    );
    await expect(chat.send('chat_x', 'The tea one')).resolves.toEqual({
      ticketId: 'chat_x',
      runId: 'run_x',
    });
  });

  it('expires after 30 idle minutes and refuses follow-ups', async () => {
    messages[1].createdAt = minutesAgo(31);
    expect((await chat.get('chat_x')).expired).toBe(true);
    await expect(chat.send('chat_x', 'hello?')).rejects.toBeInstanceOf(
      GoneException,
    );
    expect(tickets.addMessage).not.toHaveBeenCalled();
  });

  it('never expires while the agent is working or waiting for approval', async () => {
    messages[1].createdAt = minutesAgo(120);
    activeRun = { id: 'run_x', status: 'awaiting_approval' };
    const c = await chat.get('chat_x');
    expect(c.expired).toBe(false);
    expect(c.expiresAt).toBeNull();
    await expect(chat.send('chat_x', 'any news?')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
