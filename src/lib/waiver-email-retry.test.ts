import { beforeEach, describe, expect, it, vi } from "vitest";

// Il reinvio dall'area admin gira solo col database configurato: il percorso si esercita
// mockando prisma e il Graph. Qui verifichiamo che la leg "signer" reinvii la mail che la sua
// colonna ha davvero registrato, e che il filtro di stato veda i guasti di tutte le leg.
const h = vi.hoisted(() => ({
  signatureFindUnique: vi.fn(),
  signatureUpdate: vi.fn(),
  signatureFindMany: vi.fn(),
  auditCreate: vi.fn(),
  sendWaiverEmail: vi.fn(),
  sendOrganizerPending: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  appConfig: {
    databaseConfigured: true,
    timeZone: "Europe/Rome",
    publicOrigin: "https://padel.test",
    waiver: { recipientEmail: "direzione@topflysolutions.com" },
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    waiverSignature: {
      findUnique: h.signatureFindUnique,
      update: h.signatureUpdate,
      findMany: h.signatureFindMany,
    },
    auditLog: { create: h.auditCreate },
  },
}));

vi.mock("@/lib/graph", () => ({
  sendGuestWaiverConfirmationEmail: vi.fn(),
  sendGuestWithdrawalConfirmationEmail: vi.fn(),
  sendOrganizerGuestWithdrewEmail: vi.fn(),
  sendOrganizerPendingSignatureEmail: h.sendOrganizerPending,
  sendWaiverEmail: h.sendWaiverEmail,
}));

const { retryWaiverEmail, listAdminWaiverSignatures } = await import("@/lib/waiver-service");

const signedAt = new Date("2026-08-19T09:00:00.000Z");
const pdfBytes = Buffer.from([37, 80, 68, 70]);
const actor = { id: "user_1", email: "admin@topflysolutions.com" };

function bookingFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking_1",
    start: new Date("2026-08-20T16:00:00.000Z"),
    end: new Date("2026-08-20T17:00:00.000Z"),
    status: "PENDING_SIGNATURES",
    organizerName: "Mario Rossi",
    organizerEmail: "mario@topfly.it",
    playerCount: 4,
    waiverRevision: 1,
    signatureDeadlineAt: new Date("2026-08-20T12:00:00.000Z"),
    waiverSignatures: [{ bookingRevision: 1, emailStatus: "SENT", status: "ACTIVE" }],
    ...overrides,
  };
}

function signatureFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "waiver_1",
    bookingId: "booking_1",
    signerRole: "ORGANIZER",
    signerName: "Mario Rossi",
    signerEmail: "mario@topfly.it",
    signedAt,
    pdfBytes,
    emailStatus: "SENT",
    emailError: null,
    signerEmailStatus: "SENT",
    signerEmailError: null,
    booking: bookingFixture(),
    ...overrides,
  };
}

describe("reinvio delle mail dello scarico", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.signatureUpdate.mockResolvedValue({});
    h.auditCreate.mockResolvedValue({});
    h.sendWaiverEmail.mockResolvedValue({ archive: { status: "SENT" }, signer: { status: "SENT" } });
    h.sendOrganizerPending.mockResolvedValue({ status: "SENT" });
  });

  it("reinvia l'avviso attesa firme, non il PDF nudo, quando la partita aspetta ancora", async () => {
    h.signatureFindUnique.mockResolvedValue(
      signatureFixture({ signerEmailStatus: "FAILED", signerEmailError: "mailbox piena" }),
    );

    await retryWaiverEmail("waiver_1", actor);

    // La colonna signerEmail* la scrive l'avviso (PDF + link firma ospiti + link gestione), non
    // la copia nuda: reinviare sendWaiverEmail riportava la colonna a SENT e faceva sparire il
    // bottone, ma il link firma ospiti - l'unica via per far firmare gli altri - non arrivava.
    expect(h.sendOrganizerPending).toHaveBeenCalledTimes(1);
    expect(h.sendWaiverEmail).not.toHaveBeenCalled();

    const notice = h.sendOrganizerPending.mock.calls[0][0];
    expect(notice.booking.organizerEmail).toBe("mario@topfly.it");
    expect(notice.pdfBytes).toBe(pdfBytes);
    expect(notice.signedCount).toBe(1);

    const update = h.signatureUpdate.mock.calls.at(-1)![0];
    expect(update.data.signerEmailStatus).toBe("SENT");
    expect(update.data.signerEmailError).toBeNull();
  });

  it("manda la copia del PDF quando la partita non aspetta piu' le firme", async () => {
    h.signatureFindUnique.mockResolvedValue(
      signatureFixture({
        signerEmailStatus: "FAILED",
        signerEmailError: "mailbox piena",
        booking: bookingFixture({ status: "CONFIRMED" }),
      }),
    );

    await retryWaiverEmail("waiver_1", actor);

    // Confermata la partita, l'avviso non ha piu' senso: la copia al referente torna il PDF nudo.
    expect(h.sendWaiverEmail).toHaveBeenCalledTimes(1);
    expect(h.sendWaiverEmail.mock.calls[0][0].legs).toEqual(["signer"]);
    expect(h.sendOrganizerPending).not.toHaveBeenCalled();
  });

  it("separa le due leg: l'archivio passa da sendWaiverEmail, la copia dall'avviso", async () => {
    h.signatureFindUnique.mockResolvedValue(
      signatureFixture({
        emailStatus: "FAILED",
        emailError: "Graph 500",
        signerEmailStatus: "FAILED",
        signerEmailError: "Graph 500",
      }),
    );
    h.sendWaiverEmail.mockResolvedValue({ archive: { status: "SENT" } });

    await retryWaiverEmail("waiver_1", actor);

    // L'archivio legale resta l'archivio legale anche quando l'avviso possiede l'altra colonna:
    // la leg "signer" non deve finire in sendWaiverEmail, o il referente riceve due mail.
    expect(h.sendWaiverEmail.mock.calls[0][0].legs).toEqual(["archive"]);
    expect(h.sendOrganizerPending).toHaveBeenCalledTimes(1);
  });

  it("rifiuta il reinvio quando non c'e' niente da recuperare", async () => {
    h.signatureFindUnique.mockResolvedValue(signatureFixture());

    await expect(retryWaiverEmail("waiver_1", actor)).rejects.toThrow(
      "Le email di questa firma sono già state inviate.",
    );
    expect(h.sendWaiverEmail).not.toHaveBeenCalled();
    expect(h.sendOrganizerPending).not.toHaveBeenCalled();
  });
});

describe("filtro di stato dell'area admin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.signatureFindMany.mockResolvedValue([]);
  });

  it("cerca il guasto in tutte le leg che la riga mostra, non solo nell'archivio", async () => {
    await listAdminWaiverSignatures({ status: "FAILED" });

    // Archivio SENT e copia al referente FAILED e' esattamente il caso che il reinvio deve
    // recuperare: filtrando la sola emailStatus la riga era invisibile proprio a chi la cercava.
    const where = h.signatureFindMany.mock.calls[0][0].where;
    expect(where.emailStatus).toBeUndefined();
    expect(where.AND).toContainEqual({
      OR: [
        { emailStatus: "FAILED" },
        { signerRole: "ORGANIZER", signerEmailStatus: "FAILED" },
        { signerRole: "GUEST", guestEmailStatus: "FAILED" },
      ],
    });
  });

  it("lega ogni leg al ruolo che la usa", async () => {
    await listAdminWaiverSignatures({ status: "SKIPPED" });

    // Senza il vincolo sul ruolo, "SKIPPED" prenderebbe ogni riga esistente: su una firma
    // referente guestEmailStatus e' SKIPPED per costruzione, e viceversa. Non e' un guasto, e'
    // una mail che non esiste.
    const clauses = h.signatureFindMany.mock.calls[0][0].where.AND[0].OR;
    expect(clauses[1]).toEqual({ signerRole: "ORGANIZER", signerEmailStatus: "SKIPPED" });
    expect(clauses[2]).toEqual({ signerRole: "GUEST", guestEmailStatus: "SKIPPED" });
  });

  it("non filtra per stato quando non glielo si chiede", async () => {
    await listAdminWaiverSignatures({});

    const where = h.signatureFindMany.mock.calls[0][0].where;
    expect(where.AND).toBeUndefined();
  });
});
