import { createHash } from "crypto";
import type {
  Booking,
  Prisma,
  User,
  WaiverEmailStatus,
  WaiverSignature,
  WaiverSignatureStatus,
  WaiverSignerRole,
} from "@prisma/client";
import { PNG } from "pngjs";
import { runAfterResponse } from "@/lib/after-response";
import { AppError } from "@/lib/errors";
import {
  demoCancelGuestWaiverSignature,
  demoGetGuestWaiverCancelContext,
  demoGetWaiverContext,
  demoSignGuestWaiver,
} from "@/lib/demo-store";
import {
  sendGuestWaiverConfirmationEmail,
  sendOrganizerGuestWithdrewEmail,
  sendWaiverEmail,
} from "@/lib/graph";
import {
  createManageToken,
  hashManageToken,
  isManageTokenValid,
  manageTokenExpiresAt,
  normalizeEmail,
  normalizePersonName,
} from "@/lib/manage-token";
import { prisma } from "@/lib/prisma";
import { retryPrismaTransaction } from "@/lib/prisma-retry";
import { generateWaiverPdf, waiverPdfFilename, waiverRegulationPath } from "@/lib/waiver-pdf";
import { appConfig } from "@/lib/config";
import {
  cancelOutlookEventForPendingBooking,
  markBookingConfirmedIfComplete,
  runOpportunisticSignatureDeadlines,
  signatureReplacementDeadlineAt,
  syncConfirmedBooking,
} from "@/lib/signature-workflow";

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
    status: "PENDING_SIGNATURES" | "CONFIRMED" | "CANCELED";
    signatureDeadlineAt: string | null;
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
  status: WaiverSignatureStatus;
  emailStatus: WaiverEmailStatus;
  emailError: string | null;
  guestEmailStatus: WaiverEmailStatus;
  guestEmailError: string | null;
  bookingStart: string;
  bookingEnd: string;
  playerCount: number;
};

export type AdminWaiverSignatureList = {
  items: AdminWaiverSignatureItem[];
  nextCursor: string | null;
};

export type GuestWaiverCancelContext = {
  canCancel: boolean;
  signature: {
    id: string;
    signerName: string;
    signerEmail: string;
    status: "ACTIVE" | "CANCELED";
    canceledAt: string | null;
  };
  booking: {
    id: string;
    start: string;
    end: string;
    organizerName: string;
    playerCount: number;
    waiverSignedCount: number;
    remainingSignatures: number;
    status: "PENDING_SIGNATURES" | "CONFIRMED" | "CANCELED";
  };
};

type BookingForWaiver = Pick<
  Booking,
  "id" | "start" | "end" | "status" | "playerCount" | "waiverRevision"
>;

type SignatureForSummary = Pick<WaiverSignature, "bookingRevision" | "emailStatus">;
type SignatureForSummaryWithStatus = Pick<WaiverSignature, "bookingRevision" | "emailStatus" | "status">;

const minBirthDate = new Date("1900-01-01T00:00:00.000Z");
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const maxSignatureImageBytes = 300_000;
const minSignatureImageBytes = 60;
const minSignatureDarkPixels = 24;
const minSignatureWidth = 16;
const minSignatureHeight = 6;

export function validatePlayerCount(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > 4) {
    throw new AppError("Inserisci un numero giocatori tra 1 e 4.", 422);
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
    throw new AppError("Il flusso digitale self-service è disponibile solo per maggiorenni.", 422);
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
    throw new AppError("La firma disegnata è troppo pesante. Cancella e riprova.", 422);
  }

  if (bytes.length < pngSignature.length || !bytes.subarray(0, pngSignature.length).equals(pngSignature)) {
    throw new AppError("La firma deve essere un'immagine PNG valida.", 422);
  }

  assertSignatureHasInk(bytes);

  return {
    bytes,
    mimeType: "image/png",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function assertSignatureHasInk(bytes: Buffer) {
  let png: PNG;

  try {
    png = PNG.sync.read(bytes);
  } catch {
    throw new AppError("La firma deve essere un'immagine PNG valida.", 422);
  }

  let darkPixels = 0;
  let minX = png.width;
  let minY = png.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const index = (png.width * y + x) << 2;
      const red = png.data[index];
      const green = png.data[index + 1];
      const blue = png.data[index + 2];
      const alpha = png.data[index + 3];
      const average = (red + green + blue) / 3;

      if (alpha > 16 && average < 160 && Math.max(red, green, blue) < 190) {
        darkPixels += 1;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  const signatureWidth = maxX >= minX ? maxX - minX + 1 : 0;
  const signatureHeight = maxY >= minY ? maxY - minY + 1 : 0;

  if (
    darkPixels < minSignatureDarkPixels ||
    signatureWidth < minSignatureWidth ||
    signatureHeight < minSignatureHeight
  ) {
    throw new AppError("Disegna una firma valida nel riquadro.", 422);
  }
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
    errors.push("L'email del firmatario è troppo lunga.");
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
    errors.push("Accetta l'assunzione di responsabilità e manleva.");
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
  return `${baseUrl.replace(/\/$/, "")}/waiver/${bookingId}?${params.toString()}`;
}

export function buildGuestWaiverCancelUrl(
  baseUrl: string | undefined,
  signatureId: string,
  token: string | undefined,
) {
  if (!baseUrl || !token) return undefined;
  const params = new URLSearchParams({ token });
  return `${baseUrl.replace(/\/$/, "")}/waiver/cancel/${signatureId}?${params.toString()}`;
}

export function summarizeWaiverSignatures(input: {
  playerCount: number;
  waiverRevision: number;
  waiverSignatures?: Array<SignatureForSummary | SignatureForSummaryWithStatus>;
}) {
  const currentSignatures =
    input.waiverSignatures?.filter(
      (signature) =>
        signature.bookingRevision === input.waiverRevision &&
        (!("status" in signature) || signature.status === "ACTIVE"),
    ) ?? [];
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

export type PreparedWaiverSignature = {
  now: Date;
  normalized: ReturnType<typeof normalizeWaiverInput>;
  ipHash: string | null;
  userAgentHash: string | null;
  pdf: Awaited<ReturnType<typeof generateWaiverPdf>>;
};

// Il PDF dello scarico e' lo step lento (~10x rispetto alla scrittura): generarlo DENTRO la
// transazione Serializable allarga la finestra di conflitto. Chi ha gia' il booking a
// disposizione lo prepara PRIMA di aprire la tx e passa il risultato a createWaiverSignature; se
// poi la tx rileva che non si puo' piu' firmare, questo lavoro si butta e va bene cosi'.
export async function prepareWaiverSignature(
  booking: BookingForWaiver,
  input: WaiverInput,
  signerRole: "ORGANIZER" | "GUEST",
  evidence: WaiverEvidence,
): Promise<PreparedWaiverSignature> {
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

  return { now, normalized, ipHash, userAgentHash, pdf };
}

export async function createWaiverSignature(
  tx: Prisma.TransactionClient,
  booking: BookingForWaiver,
  input: WaiverInput,
  signerRole: "ORGANIZER" | "GUEST",
  evidence: WaiverEvidence,
  options: {
    cancelToken?: string;
    guestEmailStatus?: WaiverEmailStatus;
    prepared?: PreparedWaiverSignature;
  } = {},
) {
  const { now, normalized, ipHash, userAgentHash, pdf } =
    options.prepared ?? (await prepareWaiverSignature(booking, input, signerRole, evidence));

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
        guestEmailStatus: options.guestEmailStatus ?? "SKIPPED",
        cancelTokenHash: options.cancelToken ? hashManageToken(options.cancelToken) : null,
        cancelTokenExpiresAt: options.cancelToken ? manageTokenExpiresAt(booking.end) : null,
      },
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      throw new AppError("Questa email ha già firmato lo scarico per questa prenotazione.", 409);
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
    signerCopyEmail: signature.signerRole === "ORGANIZER" ? signature.signerEmail : undefined,
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

export async function sendGuestWaiverEmail(signatureId: string, cancelUrl?: string) {
  if (!appConfig.databaseConfigured) return;

  const signature = await prisma.waiverSignature.findUnique({
    where: { id: signatureId },
    include: { booking: true },
  });

  if (!signature) {
    throw new AppError("Firma waiver non trovata.", 404);
  }

  if (signature.signerRole !== "GUEST") {
    return;
  }

  const result = await sendGuestWaiverConfirmationEmail({
    booking: signature.booking,
    signerName: signature.signerName,
    signerEmail: signature.signerEmail,
    signedAt: signature.signedAt,
    cancelUrl,
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
      guestEmailStatus: result.status,
      guestEmailError: result.status === "FAILED" || result.status === "SKIPPED" ? result.error ?? null : null,
      guestEmailSentAt: result.status === "SENT" ? new Date() : null,
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

  if (booking.status !== "CONFIRMED" && booking.status !== "PENDING_SIGNATURES") {
    throw new AppError("La prenotazione non è più attiva.", 409);
  }
}

// Finora la scadenza firme era fatta rispettare SOLO dall'auto-annullo periodico: il link firma
// resta valido fino a end+24h, quindi appena il cron non chiude una pending (perche' fermo, in
// ritardo, o perche' la deadline coincide con l'inizio) un ospite puo' firmare a partita finita
// e far diventare CONFIRMED una prenotazione gia' giocata, creando anche l'evento Outlook.
// Il controllo deve stare dove si firma, non solo in chi fa pulizia.
function assertSignatureWindowOpen(
  booking: Pick<Booking, "status" | "signatureDeadlineAt">,
  now = new Date(),
) {
  if (
    booking.status === "PENDING_SIGNATURES" &&
    booking.signatureDeadlineAt &&
    booking.signatureDeadlineAt <= now
  ) {
    throw new AppError(
      "La scadenza per le firme è passata: la prenotazione non è più confermabile.",
      409,
    );
  }
}

function assertGuestCancelAccess(
  signature: Pick<WaiverSignature, "cancelTokenHash" | "cancelTokenExpiresAt" | "signerRole">,
  token: string | null | undefined,
) {
  const isValid = isManageTokenValid(
    {
      manageTokenHash: signature.cancelTokenHash,
      manageTokenExpiresAt: signature.cancelTokenExpiresAt,
    },
    token,
  );

  if (signature.signerRole !== "GUEST" || !isValid) {
    throw new AppError("Link rinuncia posto non valido o scaduto.", 403);
  }
}

// Il token rinuncia resta valido fino a end+24h (manageTokenExpiresAt): senza questo controllo
// un link vecchio cliccato a partita gia' giocata riporta la prenotazione in attesa firme e la
// fa annullare all'indietro, con mail assurde e l'archivio degli scarichi che risulta annullato
// proprio per le partite realmente giocate.
function assertGuestCancelInTime(booking: Pick<Booking, "start">, now = new Date()) {
  if (booking.start <= now) {
    throw new AppError(
      "La partita è già iniziata: non è più possibile rinunciare al posto.",
      409,
    );
  }
}

// Verita' unica sul "si puo' ancora rinunciare": firma attiva, partita non ancora iniziata e
// prenotazione ancora viva. Rispecchia i controlli che cancelGuestWaiverSignature applica prima
// di rispondere 409, cosi' l'interfaccia non promette un'azione che il server rifiuta.
export function computeGuestSeatCancelable(
  signatureStatus: "ACTIVE" | "CANCELED",
  booking: { start: Date; status: "PENDING_SIGNATURES" | "CONFIRMED" | "CANCELED" },
  now = new Date(),
) {
  return (
    signatureStatus === "ACTIVE" &&
    booking.start > now &&
    (booking.status === "CONFIRMED" || booking.status === "PENDING_SIGNATURES")
  );
}

function serializeGuestCancelContext(
  signature: WaiverSignature & {
    booking: Booking & {
      waiverSignatures?: Array<SignatureForSummaryWithStatus>;
    };
  },
  now = new Date(),
): GuestWaiverCancelContext {
  const summary = summarizeWaiverSignatures(signature.booking);

  return {
    canCancel: computeGuestSeatCancelable(signature.status, signature.booking, now),
    signature: {
      id: signature.id,
      signerName: signature.signerName,
      signerEmail: signature.signerEmail,
      status: signature.status,
      canceledAt: signature.canceledAt?.toISOString() ?? null,
    },
    booking: {
      id: signature.booking.id,
      start: signature.booking.start.toISOString(),
      end: signature.booking.end.toISOString(),
      organizerName: signature.booking.organizerName,
      playerCount: signature.booking.playerCount,
      waiverSignedCount: summary.signedCount,
      remainingSignatures: summary.remainingCount,
      status: signature.booking.status,
    },
  };
}

export async function getWaiverContext(bookingId: string, token: string | null): Promise<WaiverContext> {
  if (!appConfig.databaseConfigured) {
    return demoGetWaiverContext(bookingId, token);
  }

  await runOpportunisticSignatureDeadlines();
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      waiverSignatures: {
        select: { bookingRevision: true, emailStatus: true, status: true },
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
      status: booking.status,
      signatureDeadlineAt: booking.signatureDeadlineAt?.toISOString() ?? null,
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
  baseUrl?: string,
) {
  if (!appConfig.databaseConfigured) {
    return demoSignGuestWaiver(bookingId, token, input, evidence, baseUrl);
  }

  await runOpportunisticSignatureDeadlines({ baseUrl });
  const cancelToken = createManageToken();

  // Il booking esiste gia': leggiamo i dati e generiamo il PDF PRIMA di aprire la transazione,
  // cosi' lo step lento resta fuori dalla finestra Serializable e non moltiplica i conflitti. La
  // validazione autorevole (accesso, finestra firme, conteggio, doppia firma) resta DENTRO la tx.
  const snapshot = await prisma.booking.findUnique({ where: { id: bookingId } });

  if (!snapshot) {
    throw new AppError("Prenotazione non trovata.", 404);
  }

  assertGuestWaiverAccess(snapshot, token);
  assertSignatureWindowOpen(snapshot);

  const prepared = await prepareWaiverSignature(snapshot, input, "GUEST", evidence);

  const result = await retryPrismaTransaction(() =>
    prisma.$transaction(
      async (tx) => {
        const booking = await tx.booking.findUnique({
          where: { id: bookingId },
          include: {
            waiverSignatures: {
              select: { bookingRevision: true, emailStatus: true, status: true },
            },
          },
        });

        if (!booking) {
          throw new AppError("Prenotazione non trovata.", 404);
        }

        assertGuestWaiverAccess(booking, token);
        assertSignatureWindowOpen(booking);

        const summary = summarizeWaiverSignatures(booking);
        if (summary.signedCount >= booking.playerCount) {
          throw new AppError("Tutte le firme per questa prenotazione risultano già raccolte.", 409);
        }

        const existingSignature = await tx.waiverSignature.findFirst({
          where: {
            bookingId: booking.id,
            bookingRevision: booking.waiverRevision,
            signerEmail: normalizeEmail(input.signerEmail),
            status: "ACTIVE",
          },
          select: { id: true },
        });

        if (existingSignature) {
          throw new AppError("Questa email ha già firmato lo scarico per questa prenotazione.", 409);
        }

        const saved = await createWaiverSignature(tx, booking, input, "GUEST", evidence, {
          cancelToken,
          guestEmailStatus: "PENDING",
          prepared,
        });
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

        const confirmation = await markBookingConfirmedIfComplete(tx, booking, saved.signerEmail);

        return {
          signature: saved,
          confirmedBooking: confirmation.confirmed ? confirmation.booking : null,
        };
      },
      { isolationLevel: "Serializable" },
    ),
  );

  // Le email (Microsoft Graph) sono lo step lento: dopo la risposta. La firma e' gia' committata,
  // quindi getWaiverContext sotto riflette gia' il nuovo conteggio.
  runAfterResponse(async () => {
    await Promise.all([
      sendWaiverSignatureEmail(result.signature.id),
      sendGuestWaiverEmail(
        result.signature.id,
        buildGuestWaiverCancelUrl(baseUrl ?? appConfig.publicOrigin, result.signature.id, cancelToken),
      ),
    ]);

    if (result.confirmedBooking) {
      await syncConfirmedBooking({
        booking: result.confirmedBooking,
        baseUrl,
        guestWaiverToken: token ?? undefined,
      });
    }
  });
  return getWaiverContext(bookingId, token);
}

export async function getGuestWaiverCancelContext(
  signatureId: string,
  token: string | null,
): Promise<GuestWaiverCancelContext> {
  if (!appConfig.databaseConfigured) {
    return demoGetGuestWaiverCancelContext(signatureId, token);
  }

  await runOpportunisticSignatureDeadlines();
  const signature = await prisma.waiverSignature.findUnique({
    where: { id: signatureId },
    include: {
      booking: {
        include: {
          waiverSignatures: {
            select: { bookingRevision: true, emailStatus: true, status: true },
          },
        },
      },
    },
  });

  if (!signature) {
    throw new AppError("Firma waiver non trovata.", 404);
  }

  assertGuestCancelAccess(signature, token);
  return serializeGuestCancelContext(signature);
}

export async function cancelGuestWaiverSignature(signatureId: string, token: string | null) {
  if (!appConfig.databaseConfigured) {
    return demoCancelGuestWaiverSignature(signatureId, token);
  }

  await runOpportunisticSignatureDeadlines();
  const result = await retryPrismaTransaction(() =>
    prisma.$transaction(
      async (tx) => {
        const signature = await tx.waiverSignature.findUnique({
          where: { id: signatureId },
          include: {
            booking: {
              include: {
                waiverSignatures: {
                  select: { bookingRevision: true, emailStatus: true, status: true },
                },
              },
            },
          },
        });
  
        if (!signature) {
          throw new AppError("Firma waiver non trovata.", 404);
        }
  
        assertGuestCancelAccess(signature, token);
  
        // Dopo l'early-return: chi ha gia' rinunciato deve ricevere la risposta idempotente, non
        // un "la partita e' gia' iniziata" che gli racconta una storia diversa da quella vera.
        if (signature.status === "CANCELED") {
          return { canceled: signature, revertedBooking: null };
        }
  
        assertGuestCancelInTime(signature.booking);
  
        if (signature.booking.status !== "CONFIRMED" && signature.booking.status !== "PENDING_SIGNATURES") {
          throw new AppError("La prenotazione non è più attiva.", 409);
        }
  
        const saved = await tx.waiverSignature.update({
          where: { id: signature.id },
          data: {
            status: "CANCELED",
            canceledAt: new Date(),
          },
          include: {
            booking: {
              include: {
                waiverSignatures: {
                  select: { bookingRevision: true, emailStatus: true, status: true },
                },
              },
            },
          },
        });
  
        await tx.auditLog.create({
          data: {
            actorEmail: saved.signerEmail,
            action: "WAIVER_SIGNATURE_CANCELED",
            entityType: "WaiverSignature",
            entityId: saved.id,
            before: {
              status: "ACTIVE",
              bookingId: saved.bookingId,
              bookingRevision: saved.bookingRevision,
            },
            after: {
              status: "CANCELED",
              canceledAt: saved.canceledAt?.toISOString() ?? null,
            },
          },
        });
  
        const signedCount = saved.booking.waiverSignatures.filter(
          (item) =>
            item.bookingRevision === saved.booking.waiverRevision &&
            item.status === "ACTIVE",
        ).length;
  
        if (saved.booking.status !== "CONFIRMED" || signedCount >= saved.booking.playerCount) {
          return { canceled: saved, revertedBooking: null };
        }
  
        const revertedBooking = await tx.booking.update({
          where: { id: saved.booking.id },
          data: {
            status: "PENDING_SIGNATURES",
            signatureDeadlineAt: signatureReplacementDeadlineAt(saved.booking.start),
            signatureWindowStartedAt: new Date(),
            signatureReminderSentAt: null,
            signatureConfirmedAt: null,
            outlookSyncStatus: saved.booking.outlookEventId ? "PENDING" : "SKIPPED",
          },
        });
  
        await tx.auditLog.create({
          data: {
            actorEmail: saved.signerEmail,
            action: "BOOKING_SIGNATURES_INCOMPLETE",
            entityType: "Booking",
            entityId: saved.booking.id,
            before: {
              status: "CONFIRMED",
              waiverSignedCount: signedCount + 1,
            },
            after: {
              status: "PENDING_SIGNATURES",
              waiverSignedCount: signedCount,
              signatureDeadlineAt: revertedBooking.signatureDeadlineAt?.toISOString() ?? null,
            },
          },
        });

        return { canceled: saved, revertedBooking, signedCount };
      },
      { isolationLevel: "Serializable" },
    ),
  );

  if (result.revertedBooking) {
    const reverted = result.revertedBooking;
    const signerName = result.canceled.signerName;
    const signedCount = result.signedCount ?? 0;

    runAfterResponse(async () => {
      const pending = await cancelOutlookEventForPendingBooking(reverted);

      // Senza questa mail il referente scopre la rinuncia solo dalla cancellazione Outlook, che
      // per giunta gli dice che la prenotazione e' annullata mentre invece sta solo scadendo.
      // Il link firma ospiti non e' allegabile: il token e' salvato solo come hash.
      await sendOrganizerGuestWithdrewEmail({ booking: pending, signerName, signedCount });
    });
  }

  return getGuestWaiverCancelContext(signatureId, token);
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
  role?: WaiverSignerRole;
  query?: string;
  limit?: number;
  cursor?: string;
} = {}): Promise<AdminWaiverSignatureList> {
  if (!appConfig.databaseConfigured) {
    return { items: [], nextCursor: null };
  }

  const limit = Math.min(Math.max(input.limit ?? 50, 10), 100);
  const cursor = parseAdminWaiverCursor(input.cursor);
  const query = input.query?.trim();
  const andFilters: Prisma.WaiverSignatureWhereInput[] = [];

  if (query) {
    andFilters.push({
      OR: [
        { signerName: { contains: query, mode: "insensitive" } },
        { signerEmail: { contains: query, mode: "insensitive" } },
      ],
    });
  }

  if (cursor) {
    andFilters.push({
      OR: [
        { signedAt: { lt: cursor.signedAt } },
        { signedAt: cursor.signedAt, id: { lt: cursor.id } },
      ],
    });
  }

  const where: Prisma.WaiverSignatureWhereInput = {
    ...(input.status ? { emailStatus: input.status } : {}),
    ...(input.role ? { signerRole: input.role } : {}),
    ...(andFilters.length ? { AND: andFilters } : {}),
  };

  const signatures = await prisma.waiverSignature.findMany({
    where,
    include: {
      booking: {
        select: {
          start: true,
          end: true,
          playerCount: true,
        },
      },
    },
    orderBy: [{ signedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });

  const visibleSignatures = signatures.slice(0, limit);
  const lastSignature = visibleSignatures.at(-1);

  return {
    items: visibleSignatures.map((signature) => ({
      id: signature.id,
      bookingId: signature.bookingId,
      bookingRevision: signature.bookingRevision,
      signerRole: signature.signerRole,
      signerName: signature.signerName,
      signerEmail: signature.signerEmail,
      signedAt: signature.signedAt.toISOString(),
      status: signature.status,
      emailStatus: signature.emailStatus,
      emailError: signature.emailError,
      guestEmailStatus: signature.guestEmailStatus,
      guestEmailError: signature.guestEmailError,
      bookingStart: signature.booking.start.toISOString(),
      bookingEnd: signature.booking.end.toISOString(),
      playerCount: signature.booking.playerCount,
    })),
    nextCursor: signatures.length > limit && lastSignature ? adminWaiverCursor(lastSignature) : null,
  };
}

function adminWaiverCursor(signature: Pick<WaiverSignature, "signedAt" | "id">) {
  return Buffer.from(`${signature.signedAt.toISOString()}|${signature.id}`, "utf8").toString("base64url");
}

function parseAdminWaiverCursor(value: string | undefined) {
  if (!value) return null;

  try {
    const [signedAtRaw, id] = Buffer.from(value, "base64url").toString("utf8").split("|");
    const signedAt = new Date(signedAtRaw);
    if (!id || Number.isNaN(signedAt.getTime())) return null;
    return { signedAt, id };
  } catch {
    return null;
  }
}

export function guestWaiverTokenData(token: string, end: Date) {
  return {
    guestWaiverTokenHash: hashManageToken(token),
    guestWaiverTokenExpiresAt: manageTokenExpiresAt(end),
  };
}
