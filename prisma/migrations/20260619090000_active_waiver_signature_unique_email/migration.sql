-- Prevent duplicate active signatures by the same email on the same booking revision,
-- while still allowing historical canceled signatures to remain archived.
CREATE UNIQUE INDEX "WaiverSignature_active_booking_revision_email_key"
  ON "WaiverSignature"("bookingId", "bookingRevision", "signerEmail")
  WHERE "status" = 'ACTIVE';
