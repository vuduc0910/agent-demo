import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  ACTION_TYPES,
  isRenewalRefundable,
  proratedRefund,
} from './action-policy.js';

export const ActionPayloadSchema = z.object({
  action: z.enum(ACTION_TYPES),
  targetId: z.string().nullable(),
  newShippingAddress: z.string().nullable(),
  tag: z.string().nullable(),
  notificationMessage: z.string().nullable(),
  ticketId: z.string(),
  customerId: z.string(),
});
export type ActionPayload = z.infer<typeof ActionPayloadSchema>;

export interface ExecutionResult {
  success: boolean;
  simulated: true;
  error?: string;
  [key: string]: unknown;
}

export interface VerificationResult {
  verified: boolean;
  reason: string;
  observed?: Record<string, unknown>;
}

class ExecutionError extends Error {}

const EXECUTABLE = ['authorized', 'approved'] as const;
const MUTABLE_ORDER = ['pending', 'processing'] as const;

@Injectable()
export class ActionExecutorService {
  private readonly logger = new Logger(ActionExecutorService.name);

  constructor(private readonly prisma: PrismaService) {}

  async execute(actionId: string): Promise<ExecutionResult> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.agentAction.updateMany({
          where: { id: actionId, status: { in: [...EXECUTABLE] } },
          data: { status: 'executed' },
        });
        const action = await tx.agentAction.findUnique({
          where: { id: actionId },
        });
        if (!claimed.count) {
          if (action?.status === 'executed' && action.result)
            return action.result as unknown as ExecutionResult;
          throw new ExecutionError('ACTION_NOT_AUTHORIZED');
        }
        const payload = ActionPayloadSchema.parse(action!.payload);
        const result = await this.run(tx, payload);
        await tx.agentAction.update({
          where: { id: actionId },
          data: { result: result as Prisma.InputJsonObject },
        });
        return result;
      });
    } catch (err) {
      const result: ExecutionResult = {
        success: false,
        simulated: true,
        error: err instanceof ExecutionError ? err.message : 'EXECUTION_ERROR',
      };
      if (!(err instanceof ExecutionError)) this.logger.error(err);
      await this.prisma.agentAction.updateMany({
        where: { id: actionId, status: { in: [...EXECUTABLE] } },
        data: { status: 'failed', result: result as Prisma.InputJsonObject },
      });
      return result;
    }
  }

  async verify(actionId: string): Promise<VerificationResult> {
    const action = await this.prisma.agentAction.findUnique({
      where: { id: actionId },
    });
    if (action?.status !== 'executed')
      return { verified: false, reason: 'Action was not executed.' };
    const p = ActionPayloadSchema.parse(action.payload);
    const id = p.targetId ?? '';

    switch (p.action) {
      case 'refund_payment': {
        const pay = await this.prisma.payment.findUnique({ where: { id } });
        return this.check(
          pay?.status === 'refunded',
          'Payment status is refunded.',
          {
            paymentId: id,
            status: pay?.status,
            amount: pay && Number(pay.amount),
          },
        );
      }
      case 'cancel_subscription': {
        const sub = await this.prisma.subscription.findUnique({
          where: { id },
        });
        return this.check(
          !!sub?.cancelAtPeriodEnd,
          'Auto-renewal is off; access continues until the period ends.',
          {
            subscriptionId: id,
            status: sub?.status,
            cancelAtPeriodEnd: sub?.cancelAtPeriodEnd,
            accessUntil: sub?.currentPeriodEnd,
          },
        );
      }
      case 'cancel_subscription_with_refund': {
        const result = action.result as {
          paymentId?: string;
          amount?: number;
        } | null;
        const [sub, pay] = await Promise.all([
          this.prisma.subscription.findUnique({ where: { id } }),
          this.prisma.payment.findUnique({
            where: { id: result?.paymentId ?? '' },
          }),
        ]);
        const refundedAmount = pay?.refundedAmount
          ? Number(pay.refundedAmount)
          : null;
        return this.check(
          sub?.status === 'cancelled' &&
            (pay?.status === 'partially_refunded' ||
              pay?.status === 'refunded') &&
            refundedAmount === result?.amount,
          'Subscription is cancelled and the prorated refund is recorded on its latest charge.',
          {
            subscriptionId: id,
            status: sub?.status,
            paymentId: result?.paymentId,
            paymentStatus: pay?.status,
            chargedAmount: pay && Number(pay.amount),
            refundedAmount,
          },
        );
      }
      case 'cancel_order': {
        const order = await this.prisma.order.findUnique({ where: { id } });
        return this.check(
          order?.status === 'cancelled',
          'Order status is cancelled.',
          {
            orderId: id,
            status: order?.status,
          },
        );
      }
      case 'change_shipping_address': {
        const order = await this.prisma.order.findUnique({ where: { id } });
        return this.check(
          order?.shippingAddress === p.newShippingAddress,
          'Order shipping address matches the approved address.',
          { orderId: id, shippingAddress: order?.shippingAddress },
        );
      }
      case 'add_ticket_tag': {
        const t = await this.prisma.supportTicket.findUnique({
          where: { id: p.ticketId },
        });
        return this.check(
          !!p.tag && !!t?.tags.includes(p.tag),
          'Ticket carries the tag.',
          {
            ticketId: p.ticketId,
            tags: t?.tags,
          },
        );
      }
      default:
        return { verified: true, reason: 'Simulated side-effect-free action.' };
    }
  }

  private check(
    ok: boolean,
    reason: string,
    observed: Record<string, unknown>,
  ): VerificationResult {
    return ok
      ? { verified: true, reason, observed }
      : { verified: false, reason: `Expected: ${reason}`, observed };
  }

  private run(tx: Prisma.TransactionClient, p: ActionPayload) {
    switch (p.action) {
      case 'refund_payment':
        return this.refundVerifiedPayment(tx, p);
      case 'cancel_subscription':
        return this.cancelSubscription(tx, p);
      case 'cancel_subscription_with_refund':
        return this.cancelSubscriptionWithRefund(tx, p);
      case 'cancel_order':
        return this.cancelOrder(tx, p);
      case 'change_shipping_address':
        return this.changeShippingAddress(tx, p);
      case 'add_ticket_tag':
        return this.addTicketTag(tx, p);
      case 'send_internal_notification':
        this.logger.log(`[mock slack] #support-ops: ${p.notificationMessage}`);
        return this.ok({
          provider: 'mock_slack',
          channel: '#support-ops',
          message: p.notificationMessage,
        });
      case 'draft_customer_response':
        return this.ok({
          provider: 'mock_helpdesk',
          drafted: true,
          ticketId: p.ticketId,
        });
      default:
        throw new ExecutionError('ACTION_NOT_SUPPORTED');
    }
  }

  private ok(fields: Record<string, unknown>): ExecutionResult {
    return { success: true, simulated: true, ...fields };
  }

  private async refundVerifiedPayment(
    tx: Prisma.TransactionClient,
    p: ActionPayload,
  ) {
    const payment = await tx.payment.findUnique({
      where: { id: p.targetId ?? '' },
      include: { order: true },
    });
    if (!payment) throw new ExecutionError('PAYMENT_NOT_FOUND');
    if (!payment.order) throw new ExecutionError('NOT_AN_ORDER_PAYMENT');
    if (payment.order.customerId !== p.customerId)
      throw new ExecutionError('PAYMENT_NOT_OWNED_BY_CUSTOMER');
    if (payment.status === 'refunded')
      throw new ExecutionError('PAYMENT_ALREADY_REFUNDED');
    const { count } = await tx.payment.updateMany({
      where: { id: payment.id, status: 'captured' },
      data: {
        status: 'refunded',
        refundedAt: new Date(),
        refundedAmount: payment.amount,
      },
    });
    if (!count) throw new ExecutionError('PAYMENT_NOT_REFUNDABLE');
    return this.ok({
      provider: 'mock_stripe',
      refundId: `re_sim_${payment.id}`,
      paymentId: payment.id,
      orderId: payment.orderId,
      amount: Number(payment.amount),
      currency: payment.currency,
    });
  }

  private async cancelSubscription(
    tx: Prisma.TransactionClient,
    p: ActionPayload,
  ) {
    const sub = await this.ownedSubscription(tx, p);
    if (sub.status !== 'active')
      throw new ExecutionError('SUBSCRIPTION_NOT_ACTIVE');
    const { count } = await tx.subscription.updateMany({
      where: { id: sub.id, status: 'active', cancelAtPeriodEnd: false },
      data: { cancelAtPeriodEnd: true },
    });
    if (!count) throw new ExecutionError('SUBSCRIPTION_ALREADY_SET_TO_CANCEL');
    return this.ok({
      provider: 'mock_billing',
      subscriptionId: sub.id,
      plan: sub.plan,
      renewalStopped: true,
      accessUntil: sub.currentPeriodEnd.toISOString(),
    });
  }

  private async cancelSubscriptionWithRefund(
    tx: Prisma.TransactionClient,
    p: ActionPayload,
  ) {
    const sub = await this.ownedSubscription(tx, p);
    if (sub.status !== 'active')
      throw new ExecutionError('SUBSCRIPTION_NOT_ACTIVE');
    const charge = await tx.payment.findFirst({
      where: { subscriptionId: sub.id },
      orderBy: { capturedAt: 'desc' },
    });
    if (!charge) throw new ExecutionError('NO_SUBSCRIPTION_CHARGE');
    if (charge.status !== 'captured')
      throw new ExecutionError('PAYMENT_ALREADY_REFUNDED');
    if (!isRenewalRefundable(sub.status, charge))
      throw new ExecutionError('REFUND_WINDOW_EXPIRED');

    const now = new Date();
    const chargedAmount = Number(charge.amount);
    const proration = proratedRefund(
      chargedAmount,
      sub.currentPeriodStart,
      sub.currentPeriodEnd,
      now,
    );
    if (proration.amount <= 0) throw new ExecutionError('NOTHING_TO_REFUND');
    const refunded = await tx.payment.updateMany({
      where: { id: charge.id, status: 'captured' },
      data: {
        status:
          proration.amount === chargedAmount
            ? 'refunded'
            : 'partially_refunded',
        refundedAt: now,
        refundedAmount: proration.amount,
      },
    });
    if (!refunded.count) throw new ExecutionError('PAYMENT_NOT_REFUNDABLE');
    const cancelled = await tx.subscription.updateMany({
      where: { id: sub.id, status: 'active' },
      data: { status: 'cancelled', cancelledAt: now, cancelAtPeriodEnd: false },
    });
    if (!cancelled.count) throw new ExecutionError('SUBSCRIPTION_NOT_ACTIVE');
    return this.ok({
      provider: 'mock_stripe',
      subscriptionId: sub.id,
      plan: sub.plan,
      cancelledImmediately: true,
      refundId: `re_sim_${charge.id}`,
      paymentId: charge.id,
      amount: proration.amount,
      chargedAmount,
      usedDays: proration.usedDays,
      totalDays: proration.totalDays,
      currency: charge.currency,
    });
  }

  private async ownedSubscription(
    tx: Prisma.TransactionClient,
    p: ActionPayload,
  ) {
    const sub = await tx.subscription.findUnique({
      where: { id: p.targetId ?? '' },
    });
    if (!sub) throw new ExecutionError('SUBSCRIPTION_NOT_FOUND');
    if (sub.customerId !== p.customerId)
      throw new ExecutionError('SUBSCRIPTION_NOT_OWNED_BY_CUSTOMER');
    return sub;
  }

  private async cancelOrder(tx: Prisma.TransactionClient, p: ActionPayload) {
    const order = await this.ownedOrder(tx, p);
    const { count } = await tx.order.updateMany({
      where: { id: order.id, status: { in: [...MUTABLE_ORDER] } },
      data: { status: 'cancelled' },
    });
    if (!count) throw new ExecutionError('ORDER_NOT_CANCELLABLE');
    return this.ok({ provider: 'mock_oms', orderId: order.id });
  }

  private async changeShippingAddress(
    tx: Prisma.TransactionClient,
    p: ActionPayload,
  ) {
    const order = await this.ownedOrder(tx, p);
    const { count } = await tx.order.updateMany({
      where: { id: order.id, status: { in: [...MUTABLE_ORDER] } },
      data: { shippingAddress: p.newShippingAddress!.trim() },
    });
    if (!count) throw new ExecutionError('ORDER_ALREADY_SHIPPED');
    return this.ok({
      provider: 'mock_oms',
      orderId: order.id,
      previousAddress: order.shippingAddress,
      newAddress: p.newShippingAddress!.trim(),
    });
  }

  private async addTicketTag(tx: Prisma.TransactionClient, p: ActionPayload) {
    const t = await tx.supportTicket.findUnique({ where: { id: p.ticketId } });
    if (!t) throw new ExecutionError('TICKET_NOT_FOUND');
    if (!t.tags.includes(p.tag!))
      await tx.supportTicket.update({
        where: { id: t.id },
        data: { tags: { push: p.tag! } },
      });
    return this.ok({ provider: 'mock_helpdesk', ticketId: t.id, tag: p.tag });
  }

  private async ownedOrder(tx: Prisma.TransactionClient, p: ActionPayload) {
    const order = await tx.order.findUnique({
      where: { id: p.targetId ?? '' },
    });
    if (!order) throw new ExecutionError('ORDER_NOT_FOUND');
    if (order.customerId !== p.customerId)
      throw new ExecutionError('ORDER_NOT_OWNED_BY_CUSTOMER');
    return order;
  }
}
