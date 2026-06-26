ALTER TABLE "Booking"
  ALTER COLUMN "status" SET DEFAULT 'PENDING_SIGNATURES',
  ADD COLUMN IF NOT EXISTS "signatureDeadlineAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "signatureReminderSentAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "signatureConfirmedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "autoCanceledAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Booking_status_signatureDeadlineAt_idx"
  ON "Booking"("status", "signatureDeadlineAt");

CREATE INDEX IF NOT EXISTS "Booking_status_signatureReminderSentAt_idx"
  ON "Booking"("status", "signatureReminderSentAt");
