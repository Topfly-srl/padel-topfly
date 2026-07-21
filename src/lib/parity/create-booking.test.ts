import { demoCreateBooking, demoGetAvailability, demoLookupBookings, demoReset } from "@/lib/demo-store";
import { registerCreateBookingParity } from "@/lib/parity/scenarios";

// Lato UNIT dell'harness di parita' per la CREAZIONE: gli scenari condivisi girano contro
// demoCreateBooking in memoria, senza DB. Il gemello *.int.test.ts esegue gli STESSI scenari
// contro Postgres attraverso createBooking. Le attese (stato, conteggi, link ospiti, messaggi
// d'errore) vivono una volta sola in scenarios.ts: un demo che devia da cio' che fa la produzione
// rompe qui.
registerCreateBookingParity({
  label: "demo (in-memory)",
  reset: () => {
    demoReset();
  },
  createBooking: demoCreateBooking,
  getAvailability: demoGetAvailability,
  lookupBookings: demoLookupBookings,
});
