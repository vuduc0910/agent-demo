import { Module } from '@nestjs/common';
import { CommerceService } from './commerce.service.js';

@Module({
  providers: [CommerceService],
  exports: [CommerceService],
})
export class CommerceModule {}
