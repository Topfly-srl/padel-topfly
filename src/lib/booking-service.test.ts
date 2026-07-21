import { BookingStatus, OutlookSyncStatus } from "@/generated/prisma/client";
import { describe, expect, it } from "vitest";
import { shouldRetryOutlookDelete } from "@/lib/booking-service";

describe("booking service", () => {
  it("ritenta la cancellazione Outlook se la booking e' gia' cancellata ma la sync e' fallita", () => {
    expect(
      shouldRetryOutlookDelete({
        status: BookingStatus.CANCELED,
        outlookEventId: "event-id",
        outlookSyncStatus: OutlookSyncStatus.FAILED,
      }),
    ).toBe(true);
  });

  it("non ritenta cancellazioni Outlook gia' sincronizzate o senza evento", () => {
    expect(
      shouldRetryOutlookDelete({
        status: BookingStatus.CANCELED,
        outlookEventId: "event-id",
        outlookSyncStatus: OutlookSyncStatus.SYNCED,
      }),
    ).toBe(false);

    expect(
      shouldRetryOutlookDelete({
        status: BookingStatus.CANCELED,
        outlookEventId: null,
        outlookSyncStatus: OutlookSyncStatus.FAILED,
      }),
    ).toBe(false);
  });
});
