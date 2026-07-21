import {
  demoProcessDeadlines,
  demoReadDeadlineSnapshot,
  demoReset,
  demoSeedPendingBooking,
} from "@/lib/demo-store";
import { registerDeadlineProcessParity } from "@/lib/parity/scenarios";
import type { ParityDeadlineDriver } from "@/lib/parity/scenarios";

// Lato UNIT dell'harness di parita' per il PROCESSO SCADENZE FIRME: gli scenari condivisi girano
// contro il cron in memoria (demoProcessDeadlines), senza DB. Il gemello *.int.test.ts esegue gli
// STESSI scenari contro Postgres via processSignatureDeadlines. Le attese (conteggi sollecitati/
// chiusi, stato finale per prenotazione, sollecito inviato, chiusura automatica) vivono una volta
// sola in scenarios.ts: un cron demo che devia da quello di produzione rompe qui.
const driver: ParityDeadlineDriver = {
  label: "demo (in-memory)",
  reset: () => {
    demoReset();
  },
  seedPendingBooking: demoSeedPendingBooking,
  processDeadlines: (now) => demoProcessDeadlines(now),
  readDeadlineSnapshot: demoReadDeadlineSnapshot,
};

registerDeadlineProcessParity(driver);
