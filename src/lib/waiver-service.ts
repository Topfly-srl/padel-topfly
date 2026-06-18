import { createHash } from "crypto";
import type { Booking, Prisma, User, WaiverEmailStatus, WaiverSignature } from "@prisma/client";
import { AppError } from "@/lib/errors";
import { demoGetWaiverContext, demoSignGuestWaiver } from "@/lib/demo-store";
import { sendWaiverEmail } from "@/lib/graph";
import {
  createManageToken,
  hashManageToken,
  isManageTokenValid,
  manageTokenExpiresAt,
  normalizeEmail,
  normalizePersonName,
} from "@/lib/manage-token";
import { prisma } from "@/lib/prisma";
import { generateWaiverPdf, waiverPdfFilename, waiverRegulationPath } from "@/lib/waiver-pdf";
import { appConfig } from "@/lib/config";

export type WaiverInput = {
  signerName: string;
  signerEmail: string;
  birthDate: Date;
  birthPlace: string;
  isAdultConfirmed: boolean;
  privacyAccepted: boolean;
  regulationAccepted: boolean;
  liabilityAccepted: boolean;
  specificApprovalAccepted: boolean;
  signatureText?: string;
  signatureImageDataUrl?: string;
};

export type WaiverEvidence = {
  ip?: string | null;
  userAgent?: string | null;
};

export type WaiverContext = {
  booking: {
    id: string;
    start: string;
    end: string;
    organizerName: string;
    playerCount: number;
    waiverRevision: number;
    waiverSignedCount: number;
    remainingSignatures: number;
    documentVersion: string;
    regulationUrl: string;
  };
};

export type AdminWaiverSignatureItem = {
  id: string;
  bookingId: string;
  bookingRevision: number;
  signerRole: "ORGANIZER" | "GUEST";
  signerName: string;
  signerEmail: string;
  signedAt: string;
  emailStatus: WaiverEmailStatus;
  emailError: string | null;
  bookingStart: string;
  bookingEnd: string;
  playerCount: number;
};

type BookingForWaiver = Pick<
  Booking,
  "id" | "start" | "end" | "status" | "playerCount" | "waiverRevision"
>;

type SignatureForSummary = Pick<WaiverSignature, "bookingRevision" | "emailStatus">;

const minBirthDate = new Date("1900-01-01T00:00:00.000Z");
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const maxSignatureImageBytes = 300_000;
const minSignatureImageBytes = 60;

export function validatePlayerCount(value: number) {
  if (!Number.isInteger(value) || value < 2 || value > 4) {
    throw new AppError("Inserisci un numero giocatori tra 2 e 4.", 422);
  }

  return value;
}

function validateAdultBirthDate(birthDate: Date, now = new Date()) {
  if (Number.isNaN(birthDate.getTime()) || birthDate < minBirthDate || birthDate > now) {
    throw new AppError("Inserisci una data di nascita valida.", 422);
  }

  const adultLimit = new Date(now);
  adultLimit.setFullYear(adultLimit.getFullYear() - 18);

  if (birthDate > adultLimit) {
    throw new AppError("Il flusso digitale self-service e' disponibile solo per maggiorenni.", 422);
  }
}

function parseSignatureImageDataUrl(value: string | undefined) {
  const clean = value?.trim();
  if (!clean) {
    throw new AppError("Disegna la firma nel riquadro.", 422);
  }

  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(clean);
  if (!match) {
    throw new AppError("La firma deve essere un'immagine PNG generata dalla web app.", 422);
  }

  const bytes = Buffer.from(match[1], "base64");
  if (bytes.length < minSignatureImageBytes) {
    throw new AppError("Disegna una firma valida nel riquadro.", 422);
  }

  if (bytes.length > maxSignatureImageBytes) {
    throw new AppError("La firma disegnata e' troppo pesante. Cancella e riprova.", 422);
  }

  if (bytes.length < pngSignature.length || !bytes.subarray(0, pngSignature.length).equals(pngSignature)) {
    throw new AppError("La firma deve essere un'immagine PNG valida.", 422);
  }

  return {
    bytes,
    mimeType: "image/png",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function normalizeWaiverInput(input: WaiverInput, now = new Date()) {
  const signerName = normalizePersonName(input.signerName);
  const signerEmail = normalizeEmail(input.signerEmail);
  const birthPlace = input.birthPlace.trim().replace(/\s+/g, " ");
  const signatureText = normalizePersonName(input.signatureText ?? signerName);
  let signatureImage: ReturnType<typeof parseSignatureImageDataUrl> | null = null;
  const errors: string[] = [];

  if (signerName.split(" ").filter(Boolean).length < 2) {
    errors.push("Inserisci nome e cognome del firmatario.");
  }

  if (signerName.length > 80) {
    errors.push("Nome e cognome sono troppo lunghi.");
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(signerEmail)) {
    errors.push("Inserisci un'email valida per il firmatario.");
  }

  if (signerEmail.length > 120) {
    errors.push("L'email del firmatario e' troppo lunga.");
  }

  if (birthPlace.length < 2 || birthPlace.length > 120) {
    errors.push("Inserisci il luogo di nascita.");
  }

  try {
    validateAdultBirthDate(input.birthDate, now);
  } catch (error) {
    errors.push(error instanceof AppError ? error.message : "Data di nascita non valida.");
  }

  if (!input.isAdultConfirmed) {
    errors.push("Conferma di essere maggiorenne.");
  }

  if (!input.privacyAccepted) {
    errors.push("Conferma la presa visione dell'informativa privacy.");
  }

  if (!input.regulationAccepted) {
    errors.push("Accetta il regolamento del campo.");
  }

  if (!input.liabilityAccepted) {
    errors.push("Accetta l'assunzione di responsabilita' e manleva.");
  }

  if (!input.specificApprovalAccepted) {
    errors.push("Approva specificamente le clausole indicate.");
  }

  try {
    signatureImage = parseSignatureImageDataUrl(input.signatureImageDataUrl);
  } catch (error) {
    errors.push(error instanceof AppError ? error.message : "Firma disegnata non valida.");
  }

  if (errors.length > 0) {
    throw new AppError(errors.join(" "), 422);
  }

  return {
    signerName,
    signerEmail,
    birthDate: input.birthDate,
    birthPlace,
    isAdultConfirmed: input.isAdultConfirmed,
    signatureText,
    signatureImage,
  };
}

function hashEvidence(value: string | null | undefined) {
  const clean = value?.trim();
  if (!clean || clean === "unknown") return null;
  return createHash("sha256").update(clean).digest("hex");
}

export function createGuestWaiverToken() {
  return createManageToken();
}

export function buildGuestWaiverUrl(baseUrl: string | undefined, bookingId: string, token: string | undefined) {
  if (!baseUrl || !token) return undefined;
  const params = new URLSearchParams({ token });
  if (appConfig.isPreview) params.set("test", "1");
  return `${baseUrl.replace(/\/$/, "")}/waiver/${bookingId}?${params.toString()}`;
}

export function summarizeWaiverSignatures(input: {
  playerCount: number;
  waiverRevision: number;
  waiverSignatures?: SignatureForSummary[];
}) {
  const currentSignatures =
    input.waiverSignatures?.filter((signature) => signature.bookingRevision === input.waiverRevision) ?? [];
  const signedCount = currentSignatures.length;
  const statuses = currentSignatures.map((signature) => signature.emailStatus);
  const emailStatus: WaiverEmailStatus | null =
    statuses.length === 0
      ? null
      : statuses.includes("FAILED")
        ? "FAILED"
        : statuses.includes("PENDING")
          ? "PENDING"
          : statuses.includes("SKIPPED")
            ? "SKIPPED"
            : "SENT";

  return {
    signedCount,
    remainingCount: Math.max(0, input.playerCount - signedCount),
    emailStatus,
  };
}

export async function createWaiverSignature(
  tx: Prisma.TransactionClient,
  booking: BookingForWaiver,
  input: WaiverInput,
  signerRole: "ORGANIZER" | "GUEST",
  evidence: WaiverEvidence,
) {
  const now = new Date();
  const normalized = normalizeWaiverInput(input, now);
  const ipHash = hashEvidence(evidence.ip);
  const userAgentHash = hashEvidence(evidence.userAgent);
  const pdf = await generateWaiverPdf({
    booking,
    signer: {
      role: signerRole,
      name: normalized.signerName,
      email: normalized.signerEmail,
      birthDate: normalized.birthDate,
      birthPlace: normalized.birthPlace,
      signatureText: normalized.signatureText,
      signatureImageBytes: normalized.signatureImage?.bytes,
      signatureImageSha256: normalized.signatureImage?.sha256,
    },
    signedAt: now,
    documentVersion: appConfig.waiver.documentVersion,
    ipHash,
    userAgentHash,
  });

  try {
    return await tx.waiverSignature.create({
      data: {
        bookingId: booking.id,
        bookingRevision: booking.waiverRevision,
        signerRole,
        signerName: normalized.signerName,
        signerEmail: normalized.signerEmail,
        birthDate: normalized.birthDate,
        birthPlace: normalized.birthPlace,
        isAdultConfirmed: normalized.isAdultConfirmed,
        privacyAcceptedAt: now,
        regulationAcceptedAt: now,
        liabilityAcceptedAt: now,
        specificApprovalAcceptedAt: now,
        signatureText: normalized.signatureText,
        signatureImageBytes: normalized.signatureImage ? Buffer.from(normalized.signatureImage.bytes) : null,
        signatureImageSha256: normalized.signatureImage?.sha256 ?? null,
        signatureImageMimeType: normalized.signatureImage?.mimeType ?? null,
        signedAt: now,
        ipHash,
        userAgentHash,
        documentVersion: appConfig.waiver.documentVersion,
        pdfBytes: Buffer.from(pdf.bytes),
        pdfSha256: pdf.sha256,
        emailStatus: "PENDING",
      },
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      throw new AppError("Questa email ha gia' firmato lo scarico per questa prenotazione.", 409);
    }
    throw error;
  }
}

export async function sendWaiverSignatureEmail(signatureId: string) {
  if (!appConfig.databaseConfigured) return;

  const signature = await prisma.waiverSignature.findUnique({
    where: { id: signatureId },
    include: { booking: true },
  });

  if (!signature) {
    throw new AppError("Firma waiver non trovata.", 404);
  }

  const result = await sendWaiverEmail({
    booking: signature.booking,
    signerName: signature.signerName,
    signerEmail: signature.signerEmail,
    signedAt: signature.signedAt,
    pdfBytes: signature.pdfBytes,
    filename: waiverPdfFilename({
      bookingId: signature.bookingId,
      signerName: signature.signerName,
      signedAt: signature.signedAt,
    }),
  });

  await prisma.waiverSignature.update({
    where: { id: signature.id },
    data: {
      emailStatus: result.status,
      emailError: result.status === "FAILED" || result.status === "SKIPPED" ? result.error ?? null : null,
      emailSentAt: result.status === "SENT" ? new Date() : null,
    },
  });
}

function assertGuestWaiverAccess(
  booking: Pick<Booking, "guestWaiverTokenHash" | "guestWaiverTokenExpiresAt" | "status">,
  token: string | null | undefined,
) {
  const isValid = isManageTokenValid(
    {
      manageTokenHash: booking.guestWaiverTokenHash,
      manageTokenExpiresAt: booking.guestWaiverTokenExpiresAt,
    },
    token,
  );

  if (!isValid) {
    throw new AppError("Link firma ospiti non valido o scaduto.", 403);
  }

  if (booking.status !== "CONFIRMED") {
    throw new AppError("La prenotazione non e' piu' attiva.", 409);
  }
}

export async function getWaiverContext(bookingId: string, token: string | null): Promise<WaiverContext> {
  if (!appConfig.databaseConfigured) {
    return demoGetWaiverContext(bookingId, token);
  }

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      waiverSignatures: {
        select: { bookingRevision: true, emailStatus: true },
      },
    },
  });

  if (!booking) {
    throw new AppError("Prenotazione non trovata.", 404);
  }

  assertGuestWaiverAccess(booking, token);

  const summary = summarizeWaiverSignatures(booking);

  return {
    booking: {
      id: booking.id,
      start: booking.start.toISOString(),
      end: booking.end.toISOString(),
      organizerName: booking.organizerName,
      playerCount: booking.playerCount,
      waiverRevision: booking.waiverRevision,
      waiverSignedCount: summary.signedCount,
      remainingSignatures: summary.remainingCount,
      documentVersion: appConfig.waiver.documentVersion,
      regulationUrl: waiverRegulationPath,
    },
  };
}

export async function signGuestWaiver(
  bookingId: string,
  token: string | null,
  input: WaiverInput,
  evidence: WaiverEvidence,
) {
  if (!appConfig.databaseConfigured) {
    return demoSignGuestWaiver(bookingId, token, input, evidence);
  }

  const signature = await prisma.$transaction(
    async (tx) => {
      const booking = await tx.booking.findUnique({
        where: { id: bookingId },
        include: {
          waiverSignatures: {
            select: { bookingRevision: true, emailStatus: true },
          },
        },
      });

      if (!booking) {
        throw new AppError("Prenotazione non trovata.", 404);
      }

      assertGuestWaiverAccess(booking, token);

      const summary = summarizeWaiverSignatures(booking);
      if (summary.signedCount >= booking.playerCount) {
        throw new AppError("Tutte le firme per questa prenotazione risultano gia' raccolte.", 409);
      }

      const existingSignature = await tx.waiverSignature.findFirst({
        where: {
          bookingId: booking.id,
          bookingRevision: booking.waiverRevision,
          signerEmail: normalizeEmail(input.signerEmail),
        },
        select: { id: true },
      });

      if (existingSignature) {
        throw new AppError("Questa email ha gia' firmato lo scarico per questa prenotazione.", 409);
      }

      const saved = await createWaiverSignature(tx, booking, input, "GUEST", evidence);
      await tx.auditLog.create({
        data: {
          actorEmail: saved.signerEmail,
          action: "WAIVER_SIGNED",
          entityType: "WaiverSignature",
          entityId: saved.id,
          after: {
            bookingId: booking.id,
            bookingRevision: booking.waiverRevision,
            signerRole: "GUEST",
            signerEmail: saved.signerEmail,
            signatureImageSha256: saved.signatureImageSha256,
            pdfSha256: saved.pdfSha256,
          },
        },
      });

      return saved;
    },
    { isolationLevel: "Serializable" },
  );

  await sendWaiverSignatureEmail(signature.id);
  return getWaiverContext(bookingId, token);
}

export async function retryWaiverEmail(signatureId: string, actor: Pick<User, "id" | "email">) {
  if (!appConfig.databaseConfigured) {
    throw new AppError("Archivio firme non disponibile in demo mode.", 503);
  }

  const before = await prisma.waiverSignature.findUnique({ where: { id: signatureId } });
  if (!before) {
    throw new AppError("Firma waiver non trovata.", 404);
  }

  await sendWaiverSignatureEmail(signatureId);

  const after = await prisma.waiverSignature.findUnique({ where: { id: signatureId } });
  await prisma.auditLog.create({
    data: {
      actorId: actor.id,
      actorEmail: actor.email,
      action: "WAIVER_EMAIL_RETRIED",
      entityType: "WaiverSignature",
      entityId: signatureId,
      before: before.emailStatus,
      after: after?.emailStatus,
    },
  });

  return after;
}

export async function getAdminWaiverPdf(signatureId: string) {
  if (!appConfig.databaseConfigured) {
    throw new AppError("Archivio firme non disponibile in demo mode.", 503);
  }

  const signature = await prisma.waiverSignature.findUnique({
    where: { id: signatureId },
    select: {
      bookingId: true,
      signerName: true,
      signedAt: true,
      pdfBytes: true,
      pdfSha256: true,
    },
  });

  if (!signature) {
    throw new AppError("Firma waiver non trovata.", 404);
  }

  return {
    bytes: signature.pdfBytes,
    filename: waiverPdfFilename({
      bookingId: signature.bookingId,
      signerName: signature.signerName,
      signedAt: signature.signedAt,
    }),
    sha256: signature.pdfSha256,
  };
}

export async function listAdminWaiverSignatures(input: {
  status?: WaiverEmailStatus;
  limit?: number;
} = {}): Promise<AdminWaiverSignatureItem[]> {
  if (!appConfig.databaseConfigured) return [];

  const signatures = await prisma.waiverSignature.findMany({
    where: input.status ? { emailStatus: input.status } : undefined,
    include: {
      booking: {
        select: {
          start: true,
          end: true,
          playerCount: true,
        },
      },
    },
    orderBy: { signedAt: "desc" },
    take: input.limit ?? 50,
  });

  return signatures.map((signature) => ({
    id: signature.id,
    bookingId: signature.bookingId,
    bookingRevision: signature.bookingRevision,
    signerRole: signature.signerRole,
    signerName: signature.signerName,
    signerEmail: signature.signerEmail,
    signedAt: signature.signedAt.toISOString(),
    emailStatus: signature.emailStatus,
    emailError: signature.emailError,
    bookingStart: signature.booking.start.toISOString(),
    bookingEnd: signature.booking.end.toISOString(),
    playerCount: signature.booking.playerCount,
  }));
}

export function guestWaiverTokenData(token: string, end: Date) {
  return {
    guestWaiverTokenHash: hashManageToken(token),
    guestWaiverTokenExpiresAt: manageTokenExpiresAt(end),
  };
}
