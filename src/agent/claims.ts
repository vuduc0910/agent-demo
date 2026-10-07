import type { TrustedContext } from '../commerce/commerce.service.js';

const AMOUNT =
  /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?|\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s?(?:usd|dollars?)\b/gi;

const toCents = (n: number) => Math.round(n * 100);

export function extractAmounts(text: string): number[] {
  const amounts = [...text.matchAll(AMOUNT)].map((m) => {
    const whole = Number((m[1] ?? m[3]).replaceAll(',', ''));
    const fraction = Number((m[2] ?? m[4] ?? '').padEnd(2, '0'));
    return (whole * 100 + fraction) / 100;
  });
  return [...new Set(amounts)];
}

export function unmatchedAmounts(
  claimed: number[],
  context: TrustedContext,
): number[] {
  const known = new Set(
    [
      ...context.orders.flatMap((o) => [
        o.total,
        ...o.items.flatMap((i) => [i.unitPrice, i.unitPrice * i.quantity]),
      ]),
      ...context.payments.map((p) => p.amount),
      ...context.subscriptions.flatMap((s) => [
        s.price,
        ...(s.latestCharge ? [s.latestCharge.amount] : []),
      ]),
    ].map(toCents),
  );
  return claimed.filter((a) => !known.has(toCents(a)));
}

export const formatUsd = (amount: number) =>
  `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
