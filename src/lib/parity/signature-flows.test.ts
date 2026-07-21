import {
  demoCancelGuestWaiverSignature,
  demoCreateBooking,
  demoGetGuestWaiverCancelContext,
  demoGetWaiverContext,
  demoReadBookingSnapshot,
  demoReset,
  demoSeedGuestBooking,
  demoSignGuestWaiver,
} from "@/lib/demo-store";
import {
  registerGuestCancelParity,
  registerGuestSignatureParity,
  registerWaiverContextParity,
} from "@/lib/parity/scenarios";
import type { ParitySignatureDriver } from "@/lib/parity/scenarios";

// Lato UNIT dell'harness di parita' per i flussi FIRMA (firma ospite + rinuncia posto): gli scenari
// condivisi girano contro il demo-store in memoria, senza DB. Il gemello *.int.test.ts esegue gli
// STESSI scenari contro Postgres attraverso le funzioni di produzione. Le attese (stato, conteggi,
// finestra di sostituzione, messaggi d'errore) vivono una volta sola in scenarios.ts: un demo che
// devia da cio' che fa la produzione rompe qui.
const driver: ParitySignatureDriver = {
  label: "demo (in-memory)",
  reset: () => {
    demoReset();
  },
  createBooking: demoCreateBooking,
  getWaiverContext: demoGetWaiverContext,
  signGuestWaiver: demoSignGuestWaiver,
  seedGuestBooking: demoSeedGuestBooking,
  getGuestWaiverCancelContext: demoGetGuestWaiverCancelContext,
  cancelGuestWaiverSignature: demoCancelGuestWaiverSignature,
  readBookingSnapshot: demoReadBookingSnapshot,
};

registerGuestSignatureParity(driver);
registerWaiverContextParity(driver);
registerGuestCancelParity(driver);
