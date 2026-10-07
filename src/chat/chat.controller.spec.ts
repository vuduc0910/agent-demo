import { INestApplication, StandardSchemaValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';
import { CHAT_THROTTLE } from './chat.throttle.js';

describe('ChatController rate limit', () => {
  let app: INestApplication;
  const reply = { ticketId: 'chat_x', runId: 'run_x' };
  const chat = {
    customers: vi.fn(() => []),
    start: vi.fn(() => Promise.resolve(reply)),
    send: vi.fn(() => Promise.resolve(reply)),
    get: vi.fn(() =>
      Promise.resolve({ id: 'chat_x', messages: [], activeRun: null }),
    ),
  };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot(CHAT_THROTTLE)],
      controllers: [ChatController],
      providers: [{ provide: ChatService, useValue: chat }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new StandardSchemaValidationPipe());
    await app.init();
  });

  afterEach(() => app.close());

  it('shares one burst budget across new conversations and follow-ups', async () => {
    const server = app.getHttpServer();
    await request(server)
      .post('/chat/tickets')
      .send({ customerId: 'cus_001', message: 'hi' })
      .expect(201);
    await request(server)
      .post('/chat/tickets/chat_x/messages')
      .send({ message: 'hi' })
      .expect(202);
    await request(server)
      .post('/chat/tickets')
      .send({ customerId: null, message: 'hi' })
      .expect(201);
    const blocked = await request(server)
      .post('/chat/tickets/chat_x/messages')
      .send({ message: 'hi' })
      .expect(429);
    expect(blocked.body.message).toMatch(/too quickly/);
    expect(
      Object.keys(blocked.headers).some((h) => h.startsWith('retry-after')),
    ).toBe(true);
    expect(chat.start).toHaveBeenCalledTimes(2);
    expect(chat.send).toHaveBeenCalledTimes(1);
  });

  it('never throttles polling or the customer list', async () => {
    const server = app.getHttpServer();
    for (let i = 0; i < 10; i++) {
      await request(server).get('/chat/tickets/chat_x').expect(200);
      await request(server).get('/chat/customers').expect(200);
    }
  });
});
