import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(agentRunId: string, event: string, metadata?: object) {
    await this.prisma.auditLog.create({
      data: {
        agentRunId,
        event,
        metadata: metadata as Prisma.InputJsonValue | undefined,
      },
    });
  }
}
