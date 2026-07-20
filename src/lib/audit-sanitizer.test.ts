import { describe, expect, it } from "vitest";
import { sanitizeAuditValue } from "@/lib/audit-sanitizer";

describe("audit sanitizer", () => {
  it("rimuove token e dettagli tecnici dai payload audit", () => {
    const sanitized = sanitizeAuditValue({
      id: "booking_1",
      start: "2026-06-05T17:00:00.000Z",
      end: "2026-06-05T18:00:00.000Z",
      organizerEmail: "antony@example.com",
      organizerName: "Antony Buffone",
      status: "CONFIRMED",
      outlookSyncStatus: "SYNCED",
      manageTokenHash: "hash-da-non-salvare",
      manageTokenExpiresAt: "2026-06-06T18:00:00.000Z",
      outlookEventId: "event-da-non-salvare",
      outlookSyncError: "errore tecnico da non salvare",
      nested: {
        manageTokenHash: "hash-nested",
        status: "CONFIRMED",
      },
    });

    expect(sanitized).toEqual({
      id: "booking_1",
      start: "2026-06-05T17:00:00.000Z",
      end: "2026-06-05T18:00:00.000Z",
      organizerEmail: "antony@example.com",
      organizerName: "Antony Buffone",
      status: "CONFIRMED",
      outlookSyncStatus: "SYNCED",
      nested: {
        status: "CONFIRMED",
      },
    });
  });
});
