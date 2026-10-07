export const SECURITY_PATTERNS = [
  'instruction_override',
  'privileged_action_request',
  'system_prompt_exfiltration',
  'role_impersonation',
  'status_manipulation',
] as const;
export type SecurityPattern = (typeof SECURITY_PATTERNS)[number];
export type RiskLevel = 'low' | 'medium' | 'high';

const RULES: [SecurityPattern, RegExp][] = [
  [
    'instruction_override',
    /\b(ignore|disregard|forget|override)\b.{0,40}\b(instructions?|prompts?|rules|guidelines|policies)\b/i,
  ],
  [
    'instruction_override',
    /\byou are now\b|\bnew instructions\b|\bfrom now on,? you\b/i,
  ],
  [
    'system_prompt_exfiltration',
    /\b(reveal|show|print|repeat|leak|output|dump)\b.{0,30}\b(system prompt|hidden prompt|instructions|api keys?|secrets?)\b/i,
  ],
  ['privileged_action_request', /\b\w+\(\s*\)/],
  [
    'privileged_action_request',
    /\b(refund_payment|cancel_order|cancel_subscription|change_shipping_address|delete_customer|add_ticket_tag)\b/i,
  ],
  [
    'privileged_action_request',
    /\b(refund|transfer|credit|wire|send)\w*\b[^.\n]{0,30}\$\s?(\d{1,3}(,\d{3})+|\d{4,})/i,
  ],
  [
    'role_impersonation',
    /\b(i am|i'm|acting as|speaking as)\s+(an?\s+|the\s+)?(admin|administrator|developer|system|supervisor|ceo|manager)\b/i,
  ],
  ['role_impersonation', /^\s*\[?(system|assistant|developer)\]?\s*:/im],
  [
    'role_impersonation',
    /("|\\n)[ \t]*\[?(system|assistant|developer|support)\]?[ \t]*:/i,
  ],
  [
    'status_manipulation',
    /\b(mark|set|close)\b.{0,30}\b(ticket|case|request)\b.{0,20}\b(resolved|closed|approved)\b/i,
  ],
];

const HIGH_RISK: SecurityPattern[] = [
  'instruction_override',
  'privileged_action_request',
  'system_prompt_exfiltration',
];

export function detectInjection(message: string): {
  patterns: SecurityPattern[];
  risk: RiskLevel;
} {
  const patterns = [
    ...new Set(RULES.filter(([, re]) => re.test(message)).map(([p]) => p)),
  ];
  const risk: RiskLevel = patterns.some((p) => HIGH_RISK.includes(p))
    ? 'high'
    : patterns.length
      ? 'medium'
      : 'low';
  return { patterns, risk };
}

export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  const order: RiskLevel[] = ['low', 'medium', 'high'];
  return order[Math.max(order.indexOf(a), order.indexOf(b))];
}
