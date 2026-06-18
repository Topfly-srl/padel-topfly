CREATE TYPE "WaiverSignatureStatus" AS ENUM ('ACTIVE', 'CANCELED');

ALTER TABLE "WaiverSignature"
  ADD COLUMN "status" "WaiverSignatureStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "guestEmailStatus" "WaiverEmailStatus" NOT NULL DEFAULT 'SKIPPED',
  ADD COLUMN "guestEmailError" TEXT,
  ADD COLUMN "guestEmailSentAt" TIMESTAMP(3),
  ADD COLUMN "cancelTokenHash" TEXT,
  ADD COLUMN "cancelTokenExpiresAt" TIMESTAMP(3),
  ADD COLUMN "canceledAt" TIMESTAMP(3);

DROP INDEX IF EXISTS "WaiverSignature_bookingId_bookingRevision_signerEmail_key";

CREATE INDEX "WaiverSignature_bookingId_bookingRevision_signerEmail_idx"
  ON "WaiverSignature"("bookingId", "bookingRevision", "signerEmail");

CREATE INDEX "WaiverSignature_cancelTokenHash_idx"
  ON "WaiverSignature"("cancelTokenHash");

CREATE INDEX "WaiverSignature_guestEmailStatus_idx"
  ON "WaiverSignature"("guestEmailStatus");

CREATE INDEX "WaiverSignature_status_idx"
  ON "WaiverSignature"("status");
