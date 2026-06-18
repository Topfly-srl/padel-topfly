-- Add digital waiver tracking for every court access.
CREATE TYPE "WaiverSignerRole" AS ENUM ('ORGANIZER', 'GUEST');
CREATE TYPE "WaiverEmailStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

ALTER TABLE "Booking" ADD COLUMN "playerCount" INTEGER NOT NULL DEFAULT 4;
ALTER TABLE "Booking" ADD COLUMN "waiverRevision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Booking" ADD COLUMN "guestWaiverTokenHash" TEXT;
ALTER TABLE "Booking" ADD COLUMN "guestWaiverTokenExpiresAt" TIMESTAMP(3);

CREATE TABLE "WaiverSignature" (
  "id" TEXT NOT NULL,
  "bookingId" TEXT NOT NULL,
  "bookingRevision" INTEGER NOT NULL,
  "signerRole" "WaiverSignerRole" NOT NULL,
  "signerName" TEXT NOT NULL,
  "signerEmail" TEXT NOT NULL,
  "birthDate" TIMESTAMP(3) NOT NULL,
  "birthPlace" TEXT NOT NULL,
  "isAdultConfirmed" BOOLEAN NOT NULL,
  "privacyAcceptedAt" TIMESTAMP(3) NOT NULL,
  "regulationAcceptedAt" TIMESTAMP(3) NOT NULL,
  "liabilityAcceptedAt" TIMESTAMP(3) NOT NULL,
  "specificApprovalAcceptedAt" TIMESTAMP(3) NOT NULL,
  "signatureText" TEXT NOT NULL,
  "signedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ipHash" TEXT,
  "userAgentHash" TEXT,
  "documentVersion" TEXT NOT NULL,
  "pdfBytes" BYTEA NOT NULL,
  "pdfSha256" TEXT NOT NULL,
  "emailStatus" "WaiverEmailStatus" NOT NULL DEFAULT 'PENDING',
  "emailError" TEXT,
  "emailSentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WaiverSignature_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Booking_guestWaiverTokenHash_idx" ON "Booking"("guestWaiverTokenHash");
CREATE INDEX "WaiverSignature_bookingId_bookingRevision_idx" ON "WaiverSignature"("bookingId", "bookingRevision");
CREATE INDEX "WaiverSignature_emailStatus_idx" ON "WaiverSignature"("emailStatus");

ALTER TABLE "WaiverSignature" ADD CONSTRAINT "WaiverSignature_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
