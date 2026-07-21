import {
  demoCancelBooking,
  demoCreateAdminBlock,
  demoCreateBooking,
  demoDeleteAdminBlock,
  demoGetAdminStats,
  demoGetAvailability,
  demoListBookings,
  demoReadBookingSnapshot,
  demoReset,
  demoSeedManagedBooking,
  demoUpdateBooking,
} from "@/lib/demo-store";
import {
  parityAdminUser,
  registerAdminBlockParity,
  registerAdminStatsParity,
  registerCancelBookingParity,
  registerListBookingsParity,
  registerUpdateBookingParity,
} from "@/lib/parity/scenarios";
import type { ParityManagementDriver } from "@/lib/parity/scenarios";

// Lato UNIT dell'harness di parita' per i flussi di GESTIONE (update, cancel, elenco admin, blocchi
// admin): gli scenari condivisi girano contro il demo-store in memoria, senza DB. Il gemello
// *.int.test.ts esegue gli STESSI scenari contro Postgres attraverso le funzioni di produzione. Le
// attese (stato, causale, conteggi, link ospiti rigenerato, messaggi d'errore) vivono una volta sola
// in scenarios.ts: un demo che devia da cio' che fa la produzione rompe qui.
const driver: ParityManagementDriver = {
  label: "demo (in-memory)",
  reset: () => {
    demoReset();
  },
  adminUser: parityAdminUser,
  createBooking: demoCreateBooking,
  updateBooking: demoUpdateBooking,
  cancelBooking: demoCancelBooking,
  listBookings: demoListBookings,
  getAdminStats: demoGetAdminStats,
  getAvailability: demoGetAvailability,
  createAdminBlock: demoCreateAdminBlock,
  deleteAdminBlock: demoDeleteAdminBlock,
  seedManagedBooking: demoSeedManagedBooking,
  readBookingSnapshot: demoReadBookingSnapshot,
};

registerUpdateBookingParity(driver);
registerCancelBookingParity(driver);
registerListBookingsParity(driver);
registerAdminStatsParity(driver);
registerAdminBlockParity(driver);
