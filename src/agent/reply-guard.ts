import type { RunOutcome } from './agent.state.js';

export const MAX_REPLY_LENGTH = 1200;

const CLAIMS_DONE =
  /\b(has|have) been (successfully )?(refunded|cancell?ed|processed|issued|completed|updated|changed)\b|\b(refund|cancellation|change) (is|was) (complete|completed|processed|issued)\b/i;

export function replyViolation(
  reply: string,
  outcome: RunOutcome | undefined,
): string | null {
  if (reply.length > MAX_REPLY_LENGTH) return 'too_long';
  if (reply.includes('```')) return 'contains_code';
  if (/\bhttps?:\/\/|\bwww\./i.test(reply)) return 'contains_link';
  if (outcome !== 'completed' && CLAIMS_DONE.test(reply))
    return 'claims_unverified_completion';
  return null;
}
