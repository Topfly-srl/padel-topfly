import { PNG } from "pngjs";
import type { WaiverInput } from "@/lib/waiver-service";

// Fixture di firma e di slot condivise da unit (demo) e integrazione (Postgres): un solo posto,
// cosi' i due lati dell'harness di parita' non possono divergere sui dati d'ingresso. La firma e'
// disegnata a inchiostro vero perche' normalizeWaiverInput (prod) rifiuta un riquadro vuoto; il
// demo la ignora del tutto, quindi lo stesso data URL va bene per entrambi. int-test-support
// ri-esporta questi helper per non tenerne una seconda copia.
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

// Uno slot che viola la fascia oraria: con il default a giornata piena (00-24) l'unico modo e'
// sforare la mezzanotte locale. Le 21:15 UTC cadono alle 23:15 locali in ora legale e alle 22:15
// in ora solare (Europe/Rome): con 120 minuti la fine supera la mezzanotte in entrambi i regimi
// (e resta oltre la chiusura anche con una fascia ridotta via env). Resta allineato, futuro e con
// durata valida, cosi' l'UNICO errore atteso e' quello della fascia oraria.
export function outOfHoursSlot(offsetDays = 1, durationMinutes = 120) {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + offsetDays);
  start.setUTCHours(21, 15, 0, 0);
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  return { start, end };
}

// Uno slot con inizio disallineato dagli step di 15 minuti (18:07 UTC): resta in fascia e futuro,
// cosi' l'UNICO errore atteso e' quello dell'allineamento.
export function misalignedSlot(offsetDays = 1, durationMinutes = 60) {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + offsetDays);
  start.setUTCHours(18, 7, 0, 0);
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  return { start, end };
}

// Uno slot che parte tra `hoursFromNow` ore, misurato da adesso: i seed diretti dell'harness di
// parita' (rinuncia) bypassano la booking policy, quindi non serve ne' allineamento ne' fascia
// oraria; conta solo che start disti da adesso lo stesso su entrambi i lati, cosi' la finestra di
// sostituzione calcolata alla rinuncia cade nella stessa fascia. Con 3 ore la finestra (adesso + 2
// ore) domina la scadenza standard e ne diventa distinguibile.
export function hoursFromNowSlot(hoursFromNow: number, durationMinutes = 60) {
  const start = new Date(Date.now() + hoursFromNow * 60 * 60_000);
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  return { start, end };
}

// Uno slot gia' iniziato (start nel passato) ma con la fine abbastanza vicina da tenere valido il
// token di rinuncia (scade a fine + 24h): serve al seed della guardia "partita gia' iniziata", uno
// stato che la create pubblica rifiuta e che quindi va costruito a mano su entrambi i lati.
export function pastStartedSlot(hoursAgo = 1, durationMinutes = 60) {
  const start = new Date(Date.now() - hoursAgo * 60 * 60_000);
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  return { start, end };
}
