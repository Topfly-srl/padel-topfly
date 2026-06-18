import { createHash } from "crypto";
import { readFile } from "fs/promises";
import path from "path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { appConfig } from "@/lib/config";

export const waiverRegulationPath = "/legal/regolamento-padel-topfly-v1.pdf";
export const waiverTemplatePath = "/legal/modulo-responsabilita-padel-template-v1.pdf";

type WaiverPdfInput = {
  booking: {
    id: string;
    start: Date;
    end: Date;
    playerCount: number;
    waiverRevision: number;
  };
  signer: {
    role: "ORGANIZER" | "GUEST";
    name: string;
    email: string;
    birthDate: Date;
    birthPlace: string;
    signatureText: string;
    signatureImageBytes?: Uint8Array | null;
    signatureImageSha256?: string | null;
  };
  signedAt: Date;
  documentVersion: string;
  ipHash?: string | null;
  userAgentHash?: string | null;
};

type GeneratedWaiverPdf = {
  bytes: Uint8Array;
  sha256: string;
};

function assetPath(publicPath: string) {
  return path.join(process.cwd(), "public", publicPath.replace(/^\//, ""));
}

function pdfSafe(value: string) {
  return value
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[^\x09\x0a\x0d\x20-\x7e\u00a0-\u00ff]/g, "?");
}

function localDate(date: Date) {
  return new Intl.DateTimeFormat("it-IT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: appConfig.timeZone,
  }).format(date);
}

function localDateTime(date: Date) {
  return new Intl.DateTimeFormat("it-IT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: appConfig.timeZone,
  }).format(date);
}

function localTime(date: Date) {
  return new Intl.DateTimeFormat("it-IT", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: appConfig.timeZone,
  }).format(date);
}

function wrapText(value: string, maxLength: number) {
  const words = pdfSafe(value).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxLength && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }

  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

export function waiverPdfFilename(input: {
  bookingId: string;
  signerName: string;
  signedAt: Date;
}) {
  const cleanName = pdfSafe(input.signerName)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  const day = input.signedAt.toISOString().slice(0, 10);
  return `${appConfig.isPreview ? "test-" : ""}scarico-responsabilita-padel-${day}-${cleanName || "firmatario"}-${input.bookingId.slice(0, 8)}.pdf`;
}

export async function generateWaiverPdf(input: WaiverPdfInput): Promise<GeneratedWaiverPdf> {
  const [templateBytes, regulationBytes] = await Promise.all([
    readFile(assetPath(waiverTemplatePath)),
    readFile(assetPath(waiverRegulationPath)),
  ]);

  const pdfDoc = await PDFDocument.load(templateBytes);
  const regulationDoc = await PDFDocument.load(regulationBytes);
  pdfDoc.getForm().flatten();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdfDoc.embedFont(StandardFonts.TimesRomanItalic);
  const [page] = pdfDoc.getPages();
  const dark = rgb(0.12, 0.13, 0.16);
  const brand = rgb(0.95, 0.07, 0.09);
  const warning = rgb(0.67, 0.2, 0.07);

  const usageDate = `${localDate(input.booking.start)} ${localTime(input.booking.start)}-${localTime(input.booking.end)}`;
  const placeAndDate = `Pretoro, ${localDate(input.signedAt)}`;
  const signatureLabel = "Firma elettronica semplice acquisita tramite web app";
  const signatureImage = input.signer.signatureImageBytes
    ? await pdfDoc.embedPng(input.signer.signatureImageBytes)
    : null;
  const drawSignature = (y: number) => {
    if (signatureImage) {
      const scaled = signatureImage.scaleToFit(178, 42);
      page.drawImage(signatureImage, {
        x: 305,
        y: y + 8,
        width: scaled.width,
        height: scaled.height,
      });
    } else {
      page.drawText(pdfSafe(input.signer.signatureText), { x: 305, y: y + 16, size: 12, font: italic, color: dark });
    }
    page.drawText(pdfSafe(signatureLabel), { x: 305, y, size: 7, font: italic, color: dark });
  };

  page.drawText(pdfSafe(input.signer.name), { x: 168, y: 655, size: 10, font, color: dark });
  page.drawText(`${localDate(input.signer.birthDate)} - ${pdfSafe(input.signer.birthPlace)}`, {
    x: 168,
    y: 630,
    size: 10,
    font,
    color: dark,
  });
  page.drawText(pdfSafe(usageDate), { x: 168, y: 606, size: 10, font, color: dark });

  page.drawText(pdfSafe(placeAndDate), { x: 64, y: 282, size: 9, font, color: dark });
  drawSignature(282);
  page.drawText(pdfSafe(placeAndDate), { x: 64, y: 194, size: 9, font, color: dark });
  drawSignature(194);

  page.drawText("Documento compilato digitalmente", {
    x: 54,
    y: 72,
    size: 8,
    font: bold,
    color: brand,
  });
  page.drawText(`Versione: ${pdfSafe(input.documentVersion)} | Booking: ${input.booking.id}`, {
    x: 54,
    y: 60,
    size: 7,
    font,
    color: dark,
  });
  if (appConfig.isPreview) {
    page.drawText("AMBIENTE TEST - Documento non valido per prenotazioni reali", {
      x: 54,
      y: 48,
      size: 8,
      font: bold,
      color: warning,
    });
  }

  const evidencePage = pdfDoc.addPage([595.32, 841.92]);
  let y = 780;
  const drawLabel = (label: string, value: string) => {
    evidencePage.drawText(pdfSafe(label), { x: 54, y, size: 9, font: bold, color: dark });
    for (const line of wrapText(value, 78)) {
      evidencePage.drawText(line, { x: 190, y, size: 9, font, color: dark });
      y -= 14;
    }
    y -= 4;
  };
  const drawBullet = (value: string) => {
    for (const [index, line] of wrapText(value, 92).entries()) {
      evidencePage.drawText(index === 0 ? "-" : " ", { x: 64, y, size: 9, font, color: dark });
      evidencePage.drawText(line, { x: 78, y, size: 9, font, color: dark });
      y -= 13;
    }
  };

  evidencePage.drawText("Evidenza digitale - Scarico responsabilita' Padel TOPFLY", {
    x: 54,
    y,
    size: 16,
    font: bold,
    color: brand,
  });
  y -= 34;

  drawLabel("Firmatario", `${input.signer.name} <${input.signer.email}>`);
  drawLabel("Ruolo", input.signer.role === "ORGANIZER" ? "Referente prenotazione" : "Ospite");
  drawLabel("Nascita", `${localDate(input.signer.birthDate)} - ${input.signer.birthPlace}`);
  drawLabel("Prenotazione", `${usageDate} - ${input.booking.playerCount} giocatori`);
  drawLabel("Booking", `${input.booking.id} - revisione waiver ${input.booking.waiverRevision}`);
  drawLabel("Firmato il", localDateTime(input.signedAt));
  drawLabel("Ambiente", appConfig.isPreview ? "TEST - verifica tecnica" : "Produzione");
  drawLabel("Modalita' firma", "touch/canvas web app - firma elettronica semplice");
  drawLabel("Hash firma disegnata", input.signer.signatureImageSha256 ?? "non disponibile");
  drawLabel("Versione documenti", input.documentVersion);
  drawLabel("IP hash", input.ipHash ?? "non disponibile");
  drawLabel("User-Agent hash", input.userAgentHash ?? "non disponibile");

  y -= 8;
  evidencePage.drawText("Dichiarazioni accettate", { x: 54, y, size: 12, font: bold, color: dark });
  y -= 22;
  drawBullet("Confermo di essere maggiorenne; per minori serve autorizzazione preventiva della Direzione.");
  drawBullet("Dichiaro di aver letto e accettato integralmente il regolamento Padel TOPFLY.");
  drawBullet("Dichiaro di assumermi le responsabilita' e la manleva nei limiti consentiti dalla legge.");
  drawBullet("Approvo specificamente le clausole richiamate ai sensi degli artt. 1341 e 1342 c.c., ove applicabili.");
  drawBullet("Dichiaro di aver ricevuto o potuto consultare l'informativa privacy applicabile.");

  y -= 16;
  evidencePage.drawText("Firma acquisita", { x: 54, y, size: 12, font: bold, color: dark });
  y -= 24;
  if (signatureImage) {
    const scaled = signatureImage.scaleToFit(240, 70);
    evidencePage.drawImage(signatureImage, { x: 54, y: y - 48, width: scaled.width, height: scaled.height });
    y -= 70;
  } else {
    evidencePage.drawText(pdfSafe(input.signer.signatureText), {
      x: 54,
      y,
      size: 18,
      font: italic,
      color: dark,
    });
    y -= 26;
  }
  evidencePage.drawText("Firma elettronica semplice acquisita tramite web app.", {
    x: 54,
    y,
    size: 9,
    font,
    color: dark,
  });

  const regulationPages = await pdfDoc.copyPages(regulationDoc, regulationDoc.getPageIndices());
  for (const regulationPage of regulationPages) {
    pdfDoc.addPage(regulationPage);
  }

  const bytes = await pdfDoc.save();
  const sha256 = createHash("sha256").update(Buffer.from(bytes)).digest("hex");

  return { bytes, sha256 };
}
