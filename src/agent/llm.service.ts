import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import type { TrustedContext } from '../commerce/commerce.service.js';
import type { Env } from '../config/env.schema.js';
import {
  AnalysisSchema,
  CustomerReplySchema,
  IssueAnalysis,
  IssueFinding,
  IssueSchema,
  ProposedActionSchema,
  SecurityAssessmentSchema,
} from './agent.schemas.js';
import {
  ANALYZE_PROMPT,
  CLASSIFY_PROMPT,
  PROPOSE_PROMPT,
  REPLY_PROMPT,
  SECURITY_PROMPT,
  untrusted,
} from './prompts.js';

const trusted = (label: string, data: unknown) =>
  `<trusted_${label}>${JSON.stringify(data)}</trusted_${label}>`;

@Injectable()
export class LlmService {
  private readonly model: ChatOpenAI;

  constructor(config: ConfigService<Env, true>) {
    this.model = new ChatOpenAI({
      model: config.get('OPENAI_MODEL', { infer: true }),
      apiKey: config.get('OPENAI_API_KEY', { infer: true }),
      maxRetries: 2,
      timeout: 60_000,
    });
  }

  assessSecurity(message: string) {
    return this.structured(
      SecurityAssessmentSchema,
      'security_assessment',
      SECURITY_PROMPT,
      untrusted(message),
    );
  }

  classify(message: string) {
    return this.structured(
      IssueSchema,
      'issue_classification',
      CLASSIFY_PROMPT,
      untrusted(message),
    );
  }

  analyze(message: string, issue: IssueAnalysis, context: TrustedContext) {
    return this.structured(
      AnalysisSchema,
      'issue_analysis',
      ANALYZE_PROMPT,
      [
        untrusted(message),
        trusted('classification', issue),
        trusted('records', context),
      ].join('\n'),
    );
  }

  propose(
    issue: IssueAnalysis,
    analysis: IssueFinding,
    context: TrustedContext,
    message: string,
  ) {
    return this.structured(
      ProposedActionSchema,
      'action_proposal',
      PROPOSE_PROMPT,
      [
        untrusted(message),
        trusted('classification', issue),
        trusted('analysis', analysis),
        trusted('records', context),
      ].join('\n'),
    );
  }

  async writeReply(facts: object): Promise<string> {
    const { reply } = await this.structured(
      CustomerReplySchema,
      'customer_reply',
      REPLY_PROMPT,
      trusted('facts', facts),
    );
    return reply.trim();
  }

  private structured<T extends z.ZodObject>(
    schema: T,
    name: string,
    system: string,
    user: string,
  ): Promise<z.infer<T>> {
    return this.model
      .withStructuredOutput<z.infer<T>>(schema, { name, strict: true })
      .invoke([new SystemMessage(system), new HumanMessage(user)]);
  }
}
