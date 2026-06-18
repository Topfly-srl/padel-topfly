ALTER TABLE "WaiverSignature" ADD COLUMN "signatureImageBytes" BYTEA;
ALTER TABLE "WaiverSignature" ADD COLUMN "signatureImageSha256" TEXT;
ALTER TABLE "WaiverSignature" ADD COLUMN "signatureImageMimeType" TEXT;
