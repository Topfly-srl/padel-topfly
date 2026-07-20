import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { processSignatureDeadlines } from "@/lib/signature-workflow";
import {
  insertSignature,
  integrationDbReady,
  resetDatabase,
  settle,
  skipIntegrationReason,
} from "@/lib/int-test-support";

const hour = 60 * 60_000;
const minute = 60_000;

type PendingInput = {
  start: Date;
  signatureDeadlineAt: Date | null;
  signatureWindowStartedAt?: Date | null;
  signatureReminderSentAt?: Date | null;
  status?: "PENDING_SIGNATURES" | "CONFIRMED";
  playerCount?: number;
};

async function createBookingRow(input: PendingInput) {
  return prisma.booking.create({
    data: {
      start: input.start,
      end: new Date(input.start.getTime() + hour),
      status: input.status ?? "PENDING_SIGNATURES",
      organizerName: "Mario Rossi",
      organizerEmail: `org-${Math.random().toString(36).slice(2)}@example.com`,
      playerCount: input.playerCount ?? 2,
      signatureDeadlineAt: input.signatureDeadlineAt,
      signatureWindowStartedAt: input.signatureWindowStartedAt ?? null,
      signatureReminderSentAt: input.signatureReminderSentAt ?? null,
      outlookSyncStatus: "SKIPPED",
    },
  });
}

// Flusso critico n.2 su DB vero: le due query di processSignatureDeadlines (reminder candidates e
// cancel candidates). In demo mode queste query non sono MAI state eseguite, quindi un bug
// solo-Prisma sul filtro (o sul caso deadline == start) passerebbe inosservato. Qui giriamo il cron
// contro Postgres con uno stato preciso e verifichiamo chi viene sollecitato, chi chiuso e chi no.
describe.skipIf(!integrationDbReady)("processSignatureDeadlines (query cron su DB vero)", () => {
  if (!integrationDbReady) {
    it.skip(skipIntegrationReason, () => {});
    return;
  }

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await settle();
    await resetDatabase();
    await prisma.$disconnect();
  });

  it("sollecita chi e' nella finestra, chiude gli scaduti (incluso deadline == start) e lascia il resto", async () => {
    const now = new Date("2026-07-20T12:00:00.000Z");

    // Reminder: deadline dentro le prossime 6h, finestra abbastanza vecchia da aver superato la
    // meta' (reminderDueAt <= now), nessuna firma raccolta.
    const reminder = await createBookingRow({
      start: new Date(now.getTime() + 4 * hour),
      signatureDeadlineAt: new Date(now.getTime() + hour),
      signatureWindowStartedAt: new Date(now.getTime() - 10 * hour),
    });

    // Last minute: deadline == start, entrambi appena passati. DEVE essere chiusa: e' il caso che
    // con un filtro "scaduta E non ancora iniziata" resterebbe pending per sempre. start <= now,
    // quindi la chiusura e' silenziosa (niente mail di annullamento a posteriori).
    const deadlineEqualsStart = await createBookingRow({
      start: new Date(now.getTime() - minute),
      signatureDeadlineAt: new Date(now.getTime() - minute),
    });

    // Scaduta ma non ancora iniziata: chiusa normalmente (qui partirebbe la mail al referente, che
    // senza Graph e' SKIPPED).
    const expiredNotStarted = await createBookingRow({
      start: new Date(now.getTime() + 2 * hour),
      signatureDeadlineAt: new Date(now.getTime() - hour),
    });

    // Guardia: deadline passata ma firme gia' complete -> non si annulla.
    const fullySigned = await createBookingRow({
      start: new Date(now.getTime() + 2 * hour),
      signatureDeadlineAt: new Date(now.getTime() - 30 * minute),
      playerCount: 1,
    });
    await insertSignature({
      bookingId: fullySigned.id,
      bookingRevision: fullySigned.waiverRevision,
      signerRole: "ORGANIZER",
      signerName: "Mario Rossi",
      signerEmail: "mario.rossi@example.com",
      bookingEnd: fullySigned.end,
    });

    // Pending con deadline lontana: ne' sollecito ne' chiusura.
    const futurePending = await createBookingRow({
      start: new Date(now.getTime() + 3 * 24 * hour),
      signatureDeadlineAt: new Date(now.getTime() + 2 * 24 * hour),
    });

    // Gia' confermata: intoccabile.
    const confirmed = await createBookingRow({
      start: new Date(now.getTime() + 2 * hour),
      signatureDeadlineAt: null,
      status: "CONFIRMED",
    });

    const result = await processSignatureDeadlines({ now });

    expect(result.reminded).toBe(1);
    expect(result.canceled).toBe(2);

    const reload = async (id: string) => prisma.booking.findUniqueOrThrow({ where: { id } });

    const remindedRow = await reload(reminder.id);
    expect(remindedRow.status).toBe("PENDING_SIGNATURES");
    expect(remindedRow.signatureReminderSentAt).not.toBeNull();

    const deadlineEqualsStartRow = await reload(deadlineEqualsStart.id);
    expect(deadlineEqualsStartRow.status).toBe("CANCELED");
    expect(deadlineEqualsStartRow.autoCanceledAt).not.toBeNull();

    const expiredRow = await reload(expiredNotStarted.id);
    expect(expiredRow.status).toBe("CANCELED");
    expect(expiredRow.autoCanceledAt).not.toBeNull();

    const fullySignedRow = await reload(fullySigned.id);
    expect(fullySignedRow.status).toBe("PENDING_SIGNATURES");
    expect(fullySignedRow.autoCanceledAt).toBeNull();

    const futureRow = await reload(futurePending.id);
    expect(futureRow.status).toBe("PENDING_SIGNATURES");
    expect(futureRow.signatureReminderSentAt).toBeNull();

    const confirmedRow = await reload(confirmed.id);
    expect(confirmedRow.status).toBe("CONFIRMED");

    // La riga di sintesi datata del run, con i conteggi reali.
    const runAudit = await prisma.auditLog.findFirst({
      where: { action: "SIGNATURE_DEADLINES_RUN", entityType: "System" },
      orderBy: { createdAt: "desc" },
    });
    expect(runAudit?.after).toMatchObject({ reminded: 1, canceled: 2 });

    await settle();
  });

  it("non risollecita chi ha gia' ricevuto il promemoria", async () => {
    const now = new Date("2026-07-20T12:00:00.000Z");

    const alreadyReminded = await createBookingRow({
      start: new Date(now.getTime() + 4 * hour),
      signatureDeadlineAt: new Date(now.getTime() + hour),
      signatureWindowStartedAt: new Date(now.getTime() - 10 * hour),
      signatureReminderSentAt: new Date(now.getTime() - 30 * minute),
    });

    const result = await processSignatureDeadlines({ now });

    expect(result.reminded).toBe(0);
    expect(result.canceled).toBe(0);

    const row = await prisma.booking.findUniqueOrThrow({ where: { id: alreadyReminded.id } });
    expect(row.signatureReminderSentAt?.getTime()).toBe(now.getTime() - 30 * minute);

    await settle();
  });
});
