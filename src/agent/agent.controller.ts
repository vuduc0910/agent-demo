import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { ApprovalDecisionSchema, StartRunSchema } from './agent.schemas.js';
import type { ApprovalDecisionDto, StartRunDto } from './agent.schemas.js';
import { AgentService } from './agent.service.js';

const runId = { schema: z.uuid() };

@Controller('agent/runs')
export class AgentController {
  constructor(private readonly agent: AgentService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  start(@Body({ schema: StartRunSchema }) body: StartRunDto) {
    return this.agent.startRun(body.ticketId);
  }

  @Get()
  list(
    @Query('ticketId', { schema: z.string().max(64).optional() })
    ticketId?: string,
  ) {
    return this.agent.listRuns(ticketId);
  }

  @Get(':id')
  get(@Param('id', runId) id: string) {
    return this.agent.getRun(id);
  }

  @Post(':id/approval')
  @HttpCode(HttpStatus.ACCEPTED)
  decide(
    @Param('id', runId) id: string,
    @Body({ schema: ApprovalDecisionSchema }) body: ApprovalDecisionDto,
  ) {
    return this.agent.decide(id, body);
  }
}
