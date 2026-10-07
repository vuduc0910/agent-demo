-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE 'partially_refunded';

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "refunded_amount" DECIMAL(10,2);

UPDATE "payments" SET "refunded_amount" = "amount" WHERE "status" = 'refunded';
