-- Prevent duplicate signatures by the same email on the same booking revision.
CREATE UNIQUE INDEX "WaiverSignature_bookingId_bookingRevision_signerEmail_key"
  ON "WaiverSignature"("bookingId", "bookingRevision", "signerEmail");
