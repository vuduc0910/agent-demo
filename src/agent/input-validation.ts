import { extractAmounts } from './claims.js';

export const MAX_MESSAGE_LENGTH = 4000;
const CUSTOMER_ID = /^cus_[a-z0-9]{1,32}$/;
const ORDER_REFERENCE =
  /(?:#|\bord_|\border\s+(?:no\.?\s*|number\s*)?)(\d+)\b/gi;
const MAX_ORDER_DIGITS = 10;

export type ValidationCode =
  | 'TICKET_RESOLVED'
  | 'EMPTY_MESSAGE'
  | 'MESSAGE_TOO_LONG'
  | 'CUSTOMER_ID_MISSING'
  | 'CUSTOMER_ID_INVALID'
  | 'CUSTOMER_NOT_FOUND'
  | 'INVALID_ORDER_REFERENCE';

export interface Turn {
  author: 'customer' | 'agent';
  body: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: { code: ValidationCode; message: string }[];
  normalizedMessage: string;
  transcript: string;
  orderReferences: string[];
  latestOrderReferences: string[];
  claimedAmounts: number[];
}

const SPEAKER = { customer: 'Customer', agent: 'Support' } as const;

export function normalizeMessage(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/[^\P{Cc}\n\t]/gu, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const validReferences = (digits: string[]) => [
  ...new Set(
    digits.filter((d) => d.length >= 3 && d.length <= MAX_ORDER_DIGITS),
  ),
];

export function pickOrderReference(
  claimed: string | null,
  v: Pick<ValidationResult, 'orderReferences' | 'latestOrderReferences'>,
): string | null {
  const digits = claimed?.replace(/\D/g, '') || null;
  const pool = v.latestOrderReferences.length
    ? v.latestOrderReferences
    : v.orderReferences;
  if (digits && pool.includes(digits)) return digits;
  return pool.length === 1 ? pool[0] : null;
}

export function formatTranscript(turns: Turn[]): string {
  return turns
    .map(
      (t) =>
        `${SPEAKER[t.author]}: ${JSON.stringify(normalizeMessage(t.body))}`,
    )
    .join('\n');
}

export function validateTicket(
  ticket: { customerId: string | null; status: string; turns: Turn[] },
  customerExists: boolean,
): ValidationResult {
  const errors: ValidationResult['errors'] = [];
  const add = (code: ValidationCode, message: string) =>
    errors.push({ code, message });
  const customerTurns = ticket.turns
    .filter((t) => t.author === 'customer')
    .map((t) => normalizeMessage(t.body));
  const message = customerTurns.at(-1) ?? '';

  if (ticket.status === 'resolved')
    add('TICKET_RESOLVED', 'ticket is already resolved');
  if (!message) add('EMPTY_MESSAGE', 'message is empty');
  if (message.length > MAX_MESSAGE_LENGTH)
    add('MESSAGE_TOO_LONG', `message exceeds ${MAX_MESSAGE_LENGTH} characters`);

  if (!ticket.customerId) add('CUSTOMER_ID_MISSING', 'customer_id missing');
  else if (!CUSTOMER_ID.test(ticket.customerId))
    add('CUSTOMER_ID_INVALID', 'customer_id has an invalid format');
  else if (!customerExists)
    add('CUSTOMER_NOT_FOUND', 'customer_id does not match any customer');

  const refs = (text: string) =>
    [...text.matchAll(ORDER_REFERENCE)].map((m) => m[1]);
  const digits = customerTurns.flatMap(refs);
  const malformed = refs(message).filter((d) => d.length > MAX_ORDER_DIGITS);
  if (malformed.length)
    add(
      'INVALID_ORDER_REFERENCE',
      `order reference #${malformed[0]} is malformed`,
    );

  return {
    valid: errors.length === 0,
    errors,
    normalizedMessage: message,
    transcript: formatTranscript(ticket.turns),
    claimedAmounts: [...new Set(customerTurns.flatMap(extractAmounts))],
    orderReferences: validReferences(digits),
    latestOrderReferences: validReferences(refs(message)),
  };
}
