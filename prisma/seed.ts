import { PrismaPg } from '@prisma/adapter-pg';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { PrismaClient } from '../src/generated/prisma/client.js';

const id = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[a-z0-9]+$`));
const FIXTURE_NOW = Date.parse('2026-10-06T09:00:00Z');
const shift = Date.now() - FIXTURE_NOW;
const date = z.iso.datetime().transform((s) => new Date(Date.parse(s) + shift));
const money = z.number().nonnegative();
const currency = z.string().length(3);

const schemas = {
  customers: z.array(
    z.object({
      id: id('cus'),
      name: z.string().min(1),
      email: z.email(),
      risk_level: z.enum(['normal', 'high']),
    }),
  ),
  orders: z.array(
    z.object({
      id: id('ord'),
      customer_id: id('cus'),
      status: z.enum([
        'pending',
        'processing',
        'shipped',
        'delivered',
        'cancelled',
      ]),
      total: money,
      currency,
      tracking_number: z.string().nullable(),
      carrier: z.string().nullable(),
      shipping_address: z.string().min(1),
      created_at: date,
      delivered_at: date.nullable(),
    }),
  ),
  'order-items': z.array(
    z.object({
      id: id('item'),
      order_id: id('ord'),
      sku: z.string().min(1),
      name: z.string().min(1),
      quantity: z.number().int().positive(),
      unit_price: money,
    }),
  ),
  payments: z.array(
    z
      .object({
        id: id('pay'),
        order_id: id('ord').nullable(),
        subscription_id: id('sub').nullable(),
        amount: money,
        currency,
        status: z.enum([
          'pending',
          'captured',
          'partially_refunded',
          'refunded',
          'failed',
        ]),
        captured_at: date.nullable(),
        refunded_at: date.nullable(),
      })
      .refine((p) => (p.order_id === null) !== (p.subscription_id === null), {
        message: 'exactly one of order_id / subscription_id is required',
      }),
  ),
  subscriptions: z.array(
    z.object({
      id: id('sub'),
      customer_id: id('cus'),
      plan: z.string().min(1),
      status: z.enum(['active', 'paused', 'cancelled']),
      price: money,
      currency,
      current_period_start: date,
      current_period_end: date,
      cancel_at_period_end: z.boolean(),
      cancelled_at: date.nullable(),
    }),
  ),
};

function load<K extends keyof typeof schemas>(
  name: K,
): z.output<(typeof schemas)[K]> {
  const raw: unknown = JSON.parse(
    readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'),
  );
  const parsed = schemas[name].safeParse(raw);
  if (!parsed.success)
    throw new Error(
      `fixtures/${name}.json is invalid:\n${z.prettifyError(parsed.error)}`,
    );
  return parsed.data as z.output<(typeof schemas)[K]>;
}

const customers = load('customers');
const orders = load('orders');
const items = load('order-items');
const payments = load('payments');
const subscriptions = load('subscriptions');

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

await prisma.$transaction([
  prisma.auditLog.deleteMany(),
  prisma.approvalRequest.deleteMany(),
  prisma.agentAction.deleteMany(),
  prisma.agentRun.deleteMany(),
  prisma.supportTicket.deleteMany(),
  prisma.payment.deleteMany(),
  prisma.orderItem.deleteMany(),
  prisma.order.deleteMany(),
  prisma.subscription.deleteMany(),
  prisma.customer.deleteMany(),
  prisma.customer.createMany({
    data: customers.map((c) => ({
      id: c.id,
      name: c.name,
      email: c.email,
      riskLevel: c.risk_level,
    })),
  }),
  prisma.order.createMany({
    data: orders.map((o) => ({
      id: o.id,
      customerId: o.customer_id,
      status: o.status,
      total: o.total,
      currency: o.currency,
      trackingNumber: o.tracking_number,
      carrier: o.carrier,
      shippingAddress: o.shipping_address,
      createdAt: o.created_at,
      deliveredAt: o.delivered_at,
    })),
  }),
  prisma.orderItem.createMany({
    data: items.map((i) => ({
      id: i.id,
      orderId: i.order_id,
      sku: i.sku,
      name: i.name,
      quantity: i.quantity,
      unitPrice: i.unit_price,
    })),
  }),
  prisma.subscription.createMany({
    data: subscriptions.map((s) => ({
      id: s.id,
      customerId: s.customer_id,
      plan: s.plan,
      status: s.status,
      price: s.price,
      currency: s.currency,
      currentPeriodStart: s.current_period_start,
      currentPeriodEnd: s.current_period_end,
      cancelAtPeriodEnd: s.cancel_at_period_end,
      cancelledAt: s.cancelled_at,
    })),
  }),
  prisma.payment.createMany({
    data: payments.map((p) => ({
      id: p.id,
      orderId: p.order_id,
      subscriptionId: p.subscription_id,
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      capturedAt: p.captured_at,
      refundedAt: p.refunded_at,
      refundedAmount: p.status === 'refunded' ? p.amount : null,
    })),
  }),
]);

await prisma.$executeRawUnsafe(`
  DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'langgraph') THEN
      TRUNCATE langgraph.checkpoints, langgraph.checkpoint_blobs, langgraph.checkpoint_writes;
    END IF;
  END $$;`);

console.log(
  `Seeded ${customers.length} customers, ${orders.length} orders, ${items.length} items, ` +
    `${payments.length} payments, ${subscriptions.length} subscriptions. Support inbox cleared.`,
);
await prisma.$disconnect();
