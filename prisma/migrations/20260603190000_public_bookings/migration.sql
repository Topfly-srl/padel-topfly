-- Make bookings manageable without a required authenticated user.
ALTER TABLE "Booking" ADD COLUMN "organizerName" TEXT;
ALTER TABLE "Booking" ADD COLUMN "organizerEmail" TEXT;
ALTER TABLE "Booking" ADD COLUMN "manageTokenHash" TEXT;
ALTER TABLE "Booking" ADD COLUMN "manageTokenExpiresAt" TIMESTAMP(3);

UPDATE "Booking"
SET
  "organizerEmail" = "User"."email",
  "organizerName" = COALESCE("User"."name", "User"."email")
FROM "User"
WHERE "Booking"."organizerId" = "User"."id";

UPDATE "Booking"
SET
  "organizerEmail" = COALESCE("organizerEmail", 'unknown@invalid.local'),
  "organizerName" = COALESCE("organizerName", 'Prenotazione esistente');

ALTER TABLE "Booking" ALTER COLUMN "organizerName" SET NOT NULL;
ALTER TABLE "Booking" ALTER COLUMN "organizerEmail" SET NOT NULL;

DROP INDEX "Booking_organizerId_status_end_idx";
ALTER TABLE "Booking" DROP CONSTRAINT "Booking_organizerId_fkey";
ALTER TABLE "Booking" ALTER COLUMN "organizerId" DROP NOT NULL;
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_organizerId_fkey" FOREIGN KEY ("organizerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Booking_organizerEmail_status_end_idx" ON "Booking"("organizerEmail", "status", "end");
CREATE INDEX "Booking_manageTokenHash_idx" ON "Booking"("manageTokenHash");
