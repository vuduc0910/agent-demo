import { Module } from '@nestjs/common';
import { ActionExecutorService } from './action-executor.service.js';

@Module({
  providers: [ActionExecutorService],
  exports: [ActionExecutorService],
})
export class ActionsModule {}
