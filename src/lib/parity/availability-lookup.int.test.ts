import { describe, it } from "vitest";
import { createBooking, getAvailability, lookupBookings } from "@/lib/booking-service";
import { prisma } from "@/lib/prisma";
import {
  integrationDbReady,
  resetDatabase,
  settle,
  skipIntegrationReason,
} from "@/lib/int-test-support";
import { registerAvailabilityLookupParity } from "@/lib/parity/scenarios";

// Lato INTEGRAZIONE dell'harness di parita': gli stessi scenari di scenarios.ts girano contro un
// Postgres vero attraverso le funzioni di produzione (con DATABASE_URL, getAvailability/lookupBookings
// instradano su Prisma, non sul demo). Se il ramo Prisma devia dalle attese condivise, rompe qui;
// se devia il demo, rompe il lato unit. In nessun caso la divergenza resta invisibile.
if (!integrationDbReady) {
  describe.skip("parita availability/lookup - prisma (Postgres)", () => {
    it.skip(skipIntegrationReason, () => {});
  });
} else {
  registerAvailabilityLookupParity({
    label: "prisma (Postgres)",
    reset: resetDatabase,
    settle: () => settle(),
    teardown: async () => {
      await settle();
      await resetDatabase();
      await prisma.$disconnect();
    },
    createBooking,
    getAvailability,
    lookupBookings,
  });
}
