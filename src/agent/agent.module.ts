import { Module } from '@nestjs/common';
import { ActionsModule } from '../actions/actions.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { CommerceModule } from '../commerce/commerce.module.js';
import { TicketsModule } from '../tickets/tickets.module.js';
import { AgentController } from './agent.controller.js';
import { AgentGraphService } from './agent.graph.js';
import { AgentService } from './agent.service.js';
import { LlmService } from './llm.service.js';

@Module({
  imports: [ActionsModule, AuditModule, CommerceModule, TicketsModule],
  controllers: [AgentController],
  providers: [AgentService, AgentGraphService, LlmService],
  exports: [AgentService],
})
export class AgentModule {}
