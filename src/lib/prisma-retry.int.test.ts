import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma as PrismaNamespace } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { retryPrismaTransaction } from "@/lib/prisma-retry";
import {
  integrationDbReady,
  resetDatabase,
  settle,
  skipIntegrationReason,
} from "@/lib/int-test-support";

// L'unica cosa che l'upgrade a v7 cambia davvero nel retry e' la FORMA dell'errore: col driver
// adapter pg una serialization failure NON arriva piu' come P2034 ma come DriverAdapterError con
// `cause.originalCode === '40001'`. Gli unit test mockano quella forma a mano (quindi resterebbero
// verdi anche se il campo cambiasse nome in un adapter futuro) e gli altri int-test girano le
// transazioni Serializable in sequenza, senza collisione. Qui esercitiamo un conflitto CONCORRENTE
// VERO contro Postgres, cosi' il ramo piu' critico dell'upgrade e' coperto end-to-end: se la forma
// dell'errore cambiasse, isPrismaTransactionConflict smetterebbe di riconoscerla e questo test
// diventerebbe rosso (il retry non recupererebbe piu' il conflitto reale).

// Barriera a N parti: sblocca tutti quando N chiamanti sono arrivati. Serve a garantire che
// entrambe le transazioni facciano la LETTURA prima che una qualsiasi scriva, cosi' SSI di Postgres
// vede la write-skew e solleva 40001 su uno dei due COMMIT (conflitto deterministico, non a caso).
// Il timeout e' solo una rete di sicurezza perche' un retry che gira da solo (dopo che l'altra
// transazione ha gia' committato) non resti appeso: a quel punto la barriera e' gia' stata liberata.
function createBarrier(parties: number, timeoutMs = 3000) {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const timer = setTimeout(() => release(), timeoutMs);
  timer.unref?.();

  return async function arrive() {
    arrived += 1;
    if (arrived >= parties) {
      clearTimeout(timer);
      release();
    }
    await gate;
  };
}

describe.skipIf(!integrationDbReady)("retryPrismaTransaction su conflitto Serializable concorrente reale (DB vero)", () => {
  if (!integrationDbReady) {
    it.skip(skipIntegrationReason, () => {});
    return;
  }

  const now = new Date();
  const resetAt = new Date(now.getTime() + 60 * 60 * 1000);

  beforeEach(async () => {
    await resetDatabase();
    // Due righe su cui fare write-skew: ogni transazione legge ENTRAMBE e scrive solo la propria.
    await prisma.rateLimitBucket.createMany({
      data: [
        { key: "conflict-a", count: 0, resetAt },
        { key: "conflict-b", count: 0, resetAt },
      ],
    });
  });

  afterAll(async () => {
    await settle();
    await resetDatabase();
    await prisma.$disconnect();
  });

  it("ritenta e recupera un vero 40001 tra due $transaction Serializable in parallelo", async () => {
    const barrier = createBarrier(2);
    let attempts = 0;

    // Ogni operazione: legge entrambe le righe (predicate read -> SIREAD lock), aspetta che anche
    // l'altra abbia letto, poi incrementa SOLO la propria riga. Read-set sovrapposti + write
    // disgiunte = struttura pericolosa che SSII rileva: uno dei due COMMIT fallisce con 40001, e
    // retryPrismaTransaction lo deve ritentare. Body di sole query TIPIZZATE, come i flussi reali.
    const runWriteSkew = (ownKey: string) =>
      retryPrismaTransaction(() =>
        prisma.$transaction(
          async (tx) => {
            attempts += 1;

            await tx.rateLimitBucket.findMany({
              where: { key: { in: ["conflict-a", "conflict-b"] } },
            });

            await barrier();

            await tx.rateLimitBucket.update({
              where: { key: ownKey },
              data: { count: { increment: 1 } },
            });
          },
          { isolationLevel: PrismaNamespace.TransactionIsolationLevel.Serializable },
        ),
      );

    // Se il retry NON reggesse la forma d'errore v7, uno di questi due rigetterebbe con il 40001
    // grezzo invece di risolversi: Promise.all fallirebbe e il test sarebbe rosso.
    await Promise.all([runWriteSkew("conflict-a"), runWriteSkew("conflict-b")]);

    // Il conflitto e' avvenuto per davvero: almeno una transazione ha dovuto ripartire, quindi il
    // numero di esecuzioni del body supera le 2 partenze iniziali.
    expect(attempts).toBeGreaterThan(2);

    // Ogni riga incrementata esattamente una volta: la transazione annullata ha fatto rollback del
    // suo primo update e il retry (girato da solo) lo ha riapplicato una sola volta.
    const buckets = await prisma.rateLimitBucket.findMany({
      where: { key: { in: ["conflict-a", "conflict-b"] } },
      orderBy: { key: "asc" },
    });
    expect(buckets.map((bucket) => bucket.count)).toEqual([1, 1]);

    await settle();
  });
});
