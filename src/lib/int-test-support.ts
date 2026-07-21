import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { hashManageToken, manageTokenExpiresAt } from "@/lib/manage-token";
import { appConfig } from "@/lib/config";

// La firma disegnata e gli slot futuri vivono in un fixture condiviso con l'harness di parita'
// unit (src/lib/parity/fixtures.ts), senza dipendenze da Prisma. Qui li ri-esportiamo cosi' i
// *.int.test.ts esistenti continuano a importarli da @/lib/int-test-support come prima.
export { buildWaiverInput, futureSlot, signatureImageDataUrl } from "@/lib/parity/fixtures";

// I *.int.test.ts girano SOLO contro un Postgres vero. Senza DATABASE_URL non c'e' un DB a cui
// parlare: databaseConfigured e' false e i servizi cadrebbero nel ramo demo, quindi i test si
// auto-skippano invece di dare falsi verdi. Il messaggio esce una volta sola quando si prova a
// lanciarli a vuoto.
export const integrationDbReady = appConfig.databaseConfigured;

export const skipIntegrationReason =
  "Test di integrazione saltati: DATABASE_URL non impostata (serve un Postgres vero, vedi npm run test:integration).";

// Truncate e' piu' robusto di `migrate reset` per una suite che gira tanti test di fila: niente
// drop/ricreazione dello schema a ogni giro, solo lo svuotamento delle tabelle. Lo schema lo mette
// `prisma migrate deploy` prima della suite (in CI e in locale). RESTART IDENTITY CASCADE azzera
// tutto in un colpo rispettando le foreign key.
export async function resetDatabase() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "WaiverSignature", "Booking", "AdminBlock", "AuditLog", "RateLimitBucket", "AppSetting", "User" RESTART IDENTITY CASCADE;',
  );
}

// Gli step lenti (email Graph, sync Outlook) girano via runAfterResponse in fire-and-forget: fuori
// da un request scope diventano `void safeTask()`. Senza Graph configurato le mail sono SKIPPED ma
// il task fa comunque qualche scrittura best-effort sul DB. Diamo un tick perche' quelle scritture
// atterrino prima del truncate del test successivo, cosi' niente scrive sotto i piedi.
export async function settle(ms = 150) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// Inserimento diretto di una firma "gia' fatta": serve dove il test deve partire da uno stato
// (es. CONFIRMED con una firma ospite annullabile) e ci vuole il token di rinuncia in chiaro, che
// il flusso reale salva solo come hash e non restituisce mai.
export async function insertSignature(input: {
  bookingId: string;
  bookingRevision: number;
  signerRole: "ORGANIZER" | "GUEST";
  signerName: string;
  signerEmail: string;
  bookingEnd: Date;
  cancelToken?: string;
}) {
  const now = new Date();
  return prisma.waiverSignature.create({
    data: {
      bookingId: input.bookingId,
      bookingRevision: input.bookingRevision,
      signerRole: input.signerRole,
      signerName: input.signerName,
      signerEmail: input.signerEmail,
      birthDate: new Date("1990-01-01T00:00:00.000Z"),
      birthPlace: "Pretoro",
      isAdultConfirmed: true,
      privacyAcceptedAt: now,
      regulationAcceptedAt: now,
      liabilityAcceptedAt: now,
      specificApprovalAcceptedAt: now,
      signatureText: input.signerName,
      signedAt: now,
      documentVersion: appConfig.waiver.documentVersion,
      pdfBytes: Buffer.from("integration-test-pdf"),
      pdfSha256: createHash("sha256").update("integration-test-pdf").digest("hex"),
      emailStatus: "SENT",
      guestEmailStatus: input.signerRole === "GUEST" ? "SENT" : "SKIPPED",
      signerEmailStatus: input.signerRole === "ORGANIZER" ? "SENT" : "SKIPPED",
      cancelTokenHash: input.cancelToken ? hashManageToken(input.cancelToken) : null,
      cancelTokenExpiresAt: input.cancelToken ? manageTokenExpiresAt(input.bookingEnd) : null,
    },
  });
}
