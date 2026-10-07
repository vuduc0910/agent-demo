export type PolicyRule = 'AUTO' | 'APPROVAL' | 'DENY';

export const ACTION_POLICIES = {
  add_ticket_tag: 'AUTO',
  send_internal_notification: 'AUTO',
  draft_customer_response: 'AUTO',

  refund_payment: 'APPROVAL',
  cancel_order: 'APPROVAL',
  cancel_subscription: 'APPROVAL',
  cancel_subscription_with_refund: 'APPROVAL',
  change_shipping_address: 'APPROVAL',

  delete_customer: 'DENY',
} as const satisfies Record<string, PolicyRule>;

export type ActionType = keyof typeof ACTION_POLICIES;
export const ACTION_TYPES = Object.keys(ACTION_POLICIES) as [
  ActionType,
  ...ActionType[],
];

const APPROVAL_REASONS: Partial<Record<ActionType, string>> = {
  refund_payment: 'Financial operation requires human approval.',
  cancel_order: 'Order cancellation requires human approval.',
  cancel_subscription: 'Subscription cancellation requires human approval.',
  cancel_subscription_with_refund:
    'Refund and immediate cancellation require human approval.',
  change_shipping_address: 'Shipping changes require human approval.',
};

export const RENEWAL_REFUND_WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;

export function isRenewalRefundable(
  subscriptionStatus: string,
  latestCharge: { status: string; capturedAt: Date | string | null } | null,
  now = new Date(),
): boolean {
  if (subscriptionStatus !== 'active') return false;
  if (latestCharge?.status !== 'captured' || !latestCharge.capturedAt)
    return false;
  const age = now.getTime() - new Date(latestCharge.capturedAt).getTime();
  return age >= 0 && age <= RENEWAL_REFUND_WINDOW_DAYS * DAY_MS;
}

export interface ProratedRefund {
  amount: number;
  usedDays: number;
  totalDays: number;
}

export function proratedRefund(
  chargeAmount: number,
  periodStart: Date | string,
  periodEnd: Date | string,
  now = new Date(),
): ProratedRefund {
  const start = new Date(periodStart).getTime();
  const totalDays = Math.max(
    1,
    Math.round((new Date(periodEnd).getTime() - start) / DAY_MS),
  );
  const usedDays = Math.min(
    totalDays,
    Math.max(0, Math.ceil((now.getTime() - start) / DAY_MS)),
  );
  const cents = Math.round(chargeAmount * 100);
  return {
    amount: Math.floor((cents * (totalDays - usedDays)) / totalDays) / 100,
    usedDays,
    totalDays,
  };
}

export interface ActionRequest {
  action: ActionType;
  targetId: string | null;
  newShippingAddress: string | null;
  tag: string | null;
  notificationMessage: string | null;
}

export interface PolicyContext {
  orderIds: string[];
  paymentIds: string[];
  subscriptionIds: string[];
  refundableSubscriptionIds: string[];
  promptInjectionDetected: boolean;
  claimedAmountMismatch: boolean;
  customerRiskLevel: string;
}

export type PolicyDecisionKind = 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY';

export interface PolicyDecision {
  decision: PolicyDecisionKind;
  reason: string;
  riskLevel: 'low' | 'high';
  flags: string[];
}

export function evaluatePolicy(
  req: ActionRequest,
  ctx: PolicyContext,
): PolicyDecision {
  const flags = [
    ...(ctx.promptInjectionDetected ? ['prompt_injection_detected'] : []),
    ...(ctx.customerRiskLevel === 'high' ? ['high_risk_customer'] : []),
    ...(ctx.claimedAmountMismatch ? ['claimed_amount_mismatch'] : []),
  ];
  const deny = (reason: string): PolicyDecision => ({
    decision: 'DENY',
    reason,
    riskLevel: 'high',
    flags,
  });

  const rule: PolicyRule | undefined = Object.hasOwn(
    ACTION_POLICIES,
    req.action,
  )
    ? ACTION_POLICIES[req.action]
    : undefined;
  if (!rule) return deny(`Unknown action "${String(req.action)}".`);
  if (rule === 'DENY')
    return deny(`"${req.action}" is never permitted for the agent.`);

  const ownedTargets: Partial<Record<ActionType, string[]>> = {
    refund_payment: ctx.paymentIds,
    cancel_order: ctx.orderIds,
    change_shipping_address: ctx.orderIds,
    cancel_subscription: ctx.subscriptionIds,
    cancel_subscription_with_refund: ctx.subscriptionIds,
  };
  const owned = ownedTargets[req.action];
  if (owned && !(req.targetId && owned.includes(req.targetId)))
    return deny(
      'Target is not a verified resource belonging to this customer.',
    );

  if (
    req.action === 'cancel_subscription_with_refund' &&
    !ctx.refundableSubscriptionIds.includes(req.targetId!)
  )
    return deny(
      `Latest subscription charge is not refundable (must be captured within ${RENEWAL_REFUND_WINDOW_DAYS} days).`,
    );
  if (
    req.action === 'add_ticket_tag' &&
    !/^[a-z0-9_-]{1,32}$/.test(req.tag ?? '')
  )
    return deny('Ticket tag is missing or malformed.');
  if (
    req.action === 'send_internal_notification' &&
    !req.notificationMessage?.trim()
  )
    return deny('Internal notification has no message.');
  if (req.action === 'change_shipping_address') {
    const len = req.newShippingAddress?.trim().length ?? 0;
    if (len < 10 || len > 200)
      return deny('New shipping address is missing or malformed.');
  }

  if (rule === 'APPROVAL')
    return {
      decision: 'REQUIRE_APPROVAL',
      reason:
        APPROVAL_REASONS[req.action] ??
        'Sensitive action requires human approval.',
      riskLevel: 'high',
      flags,
    };
  return {
    decision: 'ALLOW',
    reason: 'Low-risk action is auto-approved by policy.',
    riskLevel: 'low',
    flags,
  };
}
