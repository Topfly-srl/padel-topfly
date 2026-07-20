import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import { prisma } from "@/lib/prisma";
import { hashManageToken, manageTokenExpiresAt } from "@/lib/manage-token";
import { appConfig } from "@/lib/config";
import type { WaiverInput } from "@/lib/waiver-service";

// I *.int.test.ts girano SOLO contro un Postgres vero. Senza DATABASE_URL non c'e' un DB a cui
// parlare: databaseConfigured e' false e i servizi cadrebbero nel ramo demo, quindi i test si
// auto-skippano invece di dare falsi verdi. Il messaggio esce una volta sola quando si prova a
// lanciarli a vuoto.
export const integrationDbReady = appConfig.databaseConfigured;

export const skipIntegrationReason =
  "Test di integrazione saltati: DATABASE_URL non impostata (serve un Postgres vero, vedi npm run test:integration).";

// Firma PNG con inchiostro vero: normalizeWaiverInput rifiuta un riquadro vuoto, quindi disegniamo
// una spezzata come farebbe l'utente. Stesso approccio dei test unit del waiver.
function drawDot(png: PNG, x: number, y: number, size = 2) {
  for (let yy = Math.max(0, y - size); yy <= Math.min(png.height - 1, y + size); yy += 1) {
    for (let xx = Math.max(0, x - size); xx <= Math.min(png.width - 1, x + size); xx += 1) {
      const index = (png.width * yy + xx) << 2;
      png.data[index] = 17;
      png.data[index + 1] = 24;
      png.data[index + 2] = 39;
      png.data[index + 3] = 255;
    }
  }
}

function drawSegment(png: PNG, from: [number, number], to: [number, number]) {
  const steps = Math.max(Math.abs(to[0] - from[0]), Math.abs(to[1] - from[1]));
  for (let step = 0; step <= steps; step += 1) {
    const progress = step / steps;
    drawDot(
      png,
      Math.round(from[0] + (to[0] - from[0]) * progress),
      Math.round(from[1] + (to[1] - from[1]) * progress),
      2,
    );
  }
}

function signaturePngBytes() {
  const png = new PNG({ width: 260, height: 100 });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = 255;
    png.data[index + 1] = 255;
    png.data[index + 2] = 255;
    png.data[index + 3] = 255;
  }
  drawSegment(png, [28, 62], [72, 38]);
  drawSegment(png, [72, 38], [118, 68]);
  drawSegment(png, [118, 68], [170, 34]);
  drawSegment(png, [170, 34], [220, 58]);
  return PNG.sync.write(png);
}

export const signatureImageDataUrl = `data:image/png;base64,${signaturePngBytes().toString("base64")}`;

export function buildWaiverInput(overrides: Partial<WaiverInput> = {}): WaiverInput {
  return {
    signerName: "Mario Rossi",
    signerEmail: "mario.rossi@example.com",
    birthDate: new Date("1990-01-01T00:00:00.000Z"),
    birthPlace: "Pretoro",
    isAdultConfirmed: true,
    privacyAccepted: true,
    regulationAccepted: true,
    liabilityAccepted: true,
    specificApprovalAccepted: true,
    signatureText: overrides.signerName ?? "Mario Rossi",
    signatureImageDataUrl,
    ...overrides,
  };
}

// Uno slot futuro allineato a 15 minuti (i secondi/millisecondi in UTC devono essere zero): la
// booking policy rifiuta orari disallineati o nel passato. Domani alle 18:00 UTC va bene entro i
// 14 giorni di anticipo.
export function futureSlot(offsetDays = 1, durationMinutes = 60) {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + offsetDays);
  start.setUTCHours(18, 0, 0, 0);
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  return { start, end };
}

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
