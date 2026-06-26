ALTER TYPE "BookingStatus" ADD VALUE IF NOT EXISTS 'PENDING_SIGNATURES';

ALTER TABLE "Booking"
  ALTER COLUMN "status" SET DEFAULT 'PENDING_SIGNATURES',
  ADD COLUMN "signatureDeadlineAt" TIMESTAMP(3),
  ADD COLUMN "signatureReminderSentAt" TIMESTAMP(3),
  ADD COLUMN "signatureConfirmedAt" TIMESTAMP(3),
  ADD COLUMN "autoCanceledAt" TIMESTAMP(3);

CREATE INDEX "Booking_status_signatureDeadlineAt_idx"
  ON "Booking"("status", "signatureDeadlineAt");

CREATE INDEX "Booking_status_signatureReminderSentAt_idx"
  ON "Booking"("status", "signatureReminderSentAt");
