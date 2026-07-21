import { demoCreateBooking, demoGetAvailability, demoLookupBookings, demoReset } from "@/lib/demo-store";
import { registerAvailabilityLookupParity } from "@/lib/parity/scenarios";

// Lato UNIT dell'harness di parita': gli scenari condivisi girano contro il demo-store in memoria,
// senza DB. Il gemello *.int.test.ts esegue gli STESSI scenari contro Postgres. Le attese vivono
// una volta sola in scenarios.ts, quindi un demo che devia da cio' che fa la produzione rompe qui.
registerAvailabilityLookupParity({
  label: "demo (in-memory)",
  reset: () => {
    demoReset();
  },
  createBooking: demoCreateBooking,
  getAvailability: demoGetAvailability,
  lookupBookings: demoLookupBookings,
});
