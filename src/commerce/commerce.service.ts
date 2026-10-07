import { Injectable } from '@nestjs/common';
import {
  isRenewalRefundable,
  ProratedRefund,
  proratedRefund,
} from '../actions/action-policy.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface CustomerFacts {
  id: string;
  name: string;
  email: string;
  riskLevel: string;
}

export interface OrderFacts {
  id: string;
  status: string;
  total: number;
  currency: string;
  trackingNumber: string | null;
  carrier: string | null;
  shippingAddress: string;
  createdAt: string;
  deliveredAt: string | null;
  items: { sku: string; name: string; quantity: number; unitPrice: number }[];
}

export interface PaymentFacts {
  id: string;
  orderId: string;
  amount: number;
  currency: string;
  status: string;
  capturedAt: string | null;
  refundedAt: string | null;
}

export interface SubscriptionFacts {
  id: string;
  plan: string;
  status: string;
  price: number;
  currency: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  nextRenewalAt: string | null;
  latestCharge: {
    paymentId: string;
    amount: number;
    currency: string;
    status: string;
    capturedAt: string | null;
  } | null;
  renewalRefundEligible: boolean;
  proratedRefundPreview: ProratedRefund | null;
}

export interface TrustedContext {
  customer: CustomerFacts;
  referencedOrderId: string | null;
  referencedOrderFound: boolean;
  orders: OrderFacts[];
  payments: PaymentFacts[];
  subscriptions: SubscriptionFacts[];
}

const RECENT_ORDERS = 5;
const iso = (d: Date | null) => d?.toISOString() ?? null;

@Injectable()
export class CommerceService {
  constructor(private readonly prisma: PrismaService) {}

  listCustomers() {
    return this.prisma.customer.findMany({
      select: { id: true, name: true, email: true },
      orderBy: { id: 'asc' },
    });
  }

  async findCustomer(id: string): Promise<CustomerFacts | null> {
    const c = await this.prisma.customer.findUnique({ where: { id } });
    return (
      c && { id: c.id, name: c.name, email: c.email, riskLevel: c.riskLevel }
    );
  }

  async getTrustedContext(
    customer: CustomerFacts,
    orderNumber: string | null,
  ): Promise<TrustedContext> {
    const referencedOrderId = orderNumber ? `ord_${orderNumber}` : null;
    const orders = await this.prisma.order.findMany({
      where: {
        customerId: customer.id,
        ...(referencedOrderId && { id: referencedOrderId }),
      },
      include: { items: true, payments: { orderBy: { id: 'asc' } } },
      orderBy: { createdAt: 'desc' },
      take: RECENT_ORDERS,
    });
    const subscriptions = await this.prisma.subscription.findMany({
      where: { customerId: customer.id },
      include: { payments: { orderBy: { capturedAt: 'desc' }, take: 1 } },
      orderBy: { id: 'asc' },
    });

    return {
      customer,
      referencedOrderId,
      referencedOrderFound: !!referencedOrderId && orders.length > 0,
      orders: orders.map((o) => ({
        id: o.id,
        status: o.status,
        total: Number(o.total),
        currency: o.currency,
        trackingNumber: o.trackingNumber,
        carrier: o.carrier,
        shippingAddress: o.shippingAddress,
        createdAt: o.createdAt.toISOString(),
        deliveredAt: iso(o.deliveredAt),
        items: o.items.map((i) => ({
          sku: i.sku,
          name: i.name,
          quantity: i.quantity,
          unitPrice: Number(i.unitPrice),
        })),
      })),
      payments: orders.flatMap((o) =>
        o.payments.map((p) => ({
          id: p.id,
          orderId: o.id,
          amount: Number(p.amount),
          currency: p.currency,
          status: p.status,
          capturedAt: iso(p.capturedAt),
          refundedAt: iso(p.refundedAt),
        })),
      ),
      subscriptions: subscriptions.map((s) => {
        const charge = s.payments[0];
        const eligible = isRenewalRefundable(s.status, charge ?? null);
        return {
          id: s.id,
          plan: s.plan,
          status: s.status,
          price: Number(s.price),
          currency: s.currency,
          currentPeriodStart: s.currentPeriodStart.toISOString(),
          currentPeriodEnd: s.currentPeriodEnd.toISOString(),
          cancelAtPeriodEnd: s.cancelAtPeriodEnd,
          nextRenewalAt:
            s.status === 'active' && !s.cancelAtPeriodEnd
              ? s.currentPeriodEnd.toISOString()
              : null,
          latestCharge: charge
            ? {
                paymentId: charge.id,
                amount: Number(charge.amount),
                currency: charge.currency,
                status: charge.status,
                capturedAt: iso(charge.capturedAt),
              }
            : null,
          renewalRefundEligible: eligible,
          proratedRefundPreview: eligible
            ? proratedRefund(
                Number(charge.amount),
                s.currentPeriodStart,
                s.currentPeriodEnd,
              )
            : null,
        };
      }),
    };
  }
}
