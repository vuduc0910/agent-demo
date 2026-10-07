import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { AgentModule } from '../agent/agent.module.js';
import { CommerceModule } from '../commerce/commerce.module.js';
import { TicketsModule } from '../tickets/tickets.module.js';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';
import { CHAT_THROTTLE } from './chat.throttle.js';

@Module({
  imports: [
    AgentModule,
    CommerceModule,
    TicketsModule,
    ThrottlerModule.forRoot(CHAT_THROTTLE),
  ],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
