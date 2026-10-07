import { z } from 'zod';
import { ACTION_TYPES } from '../actions/action-policy.js';
import { SECURITY_PATTERNS } from './security-heuristics.js';

const severity = z.enum(['low', 'medium', 'high']);
const confidence = z.number().min(0).max(1);

export const ISSUE_TYPES = [
  'order_tracking',
  'duplicate_payment',
  'refund_request',
  'subscription_cancellation',
  'subscription_renewal_refund',
  'wrong_product',
  'delivered_not_received',
  'shipping_address_change',
  'account_deletion',
  'off_topic',
  'unclear',
] as const;

export const SecurityAssessmentSchema = z.object({
  prompt_injection_detected: z.boolean(),
  risk: severity,
  patterns: z.array(z.enum(SECURITY_PATTERNS)),
  genuine_support_request: z.boolean(),
  explanation: z.string(),
});

export const IssueSchema = z.object({
  category: z.enum([
    'billing',
    'shipping',
    'subscription',
    'product',
    'account',
    'other',
  ]),
  issue_type: z.enum(ISSUE_TYPES),
  severity,
  order_reference: z.string().nullable(),
  customer_intent: z.string(),
  summary: z.string(),
  confidence,
});
export type IssueAnalysis = z.infer<typeof IssueSchema>;

export const AnalysisSchema = z.object({
  issue_confirmed: z.boolean(),
  finding: z.string(),
  evidence_ids: z.array(z.string()),
  severity,
  recommended_resolution: z.string(),
  confidence,
});
export type IssueFinding = z.infer<typeof AnalysisSchema>;

export const ProposedActionSchema = z.object({
  action: z.enum(ACTION_TYPES),
  target_id: z.string().nullable(),
  new_shipping_address: z.string().nullable(),
  tag: z.string().nullable(),
  notification_message: z.string().nullable(),
  reason: z.string(),
  risk: severity,
});
export type ProposedAction = z.infer<typeof ProposedActionSchema>;

export const CustomerReplySchema = z.object({ reply: z.string() });

export const StartRunSchema = z.object({
  ticketId: z
    .string()
    .trim()
    .regex(/^[a-z0-9_]{1,64}$/),
});
export type StartRunDto = z.infer<typeof StartRunSchema>;

export const ApprovalDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  reviewer: z.string().trim().min(1).max(64),
  reason: z.string().trim().max(500).optional(),
});
export type ApprovalDecisionDto = z.infer<typeof ApprovalDecisionSchema>;
