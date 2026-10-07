-- DropForeignKey
ALTER TABLE "payments" DROP CONSTRAINT "payments_order_id_fkey";

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "subscription_id" TEXT,
ALTER COLUMN "order_id" DROP NOT NULL;

ALTER TABLE "payments" ADD CONSTRAINT "payments_single_owner_check" CHECK (num_nonnulls("order_id", "subscription_id") = 1);

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "current_period_end" TIMESTAMP(3),
ADD COLUMN     "current_period_start" TIMESTAMP(3);

UPDATE "subscriptions"
SET "current_period_end" = COALESCE("renews_at", "cancelled_at", CURRENT_TIMESTAMP),
    "current_period_start" = COALESCE("renews_at", "cancelled_at", CURRENT_TIMESTAMP) - INTERVAL '1 month';

ALTER TABLE "subscriptions" ALTER COLUMN "current_period_end" SET NOT NULL,
ALTER COLUMN "current_period_start" SET NOT NULL,
DROP COLUMN "renews_at";

-- CreateIndex
CREATE INDEX "payments_subscription_id_idx" ON "payments"("subscription_id");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
