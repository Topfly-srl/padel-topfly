import { describe, expect, it } from "vitest";
import { buildShortGuestWaiverLink, normalizeGuestWaiverLink } from "@/lib/guest-waiver-link";

describe("guest waiver links", () => {
  const origin = "https://padel.topflysolutions.com";

  it("normalizes waiver links to the current origin", () => {
    expect(
      normalizeGuestWaiverLink(
        "https://old.example.com/waiver/booking_123?token=abc",
        origin,
      ),
    ).toBe("https://padel.topflysolutions.com/waiver/booking_123?token=abc");
  });

  it("builds a short share link for guest waiver URLs", () => {
    expect(
      buildShortGuestWaiverLink(
        "https://padel.topflysolutions.com/waiver/booking_123?token=abc-DEF_123",
        origin,
      ),
    ).toBe("https://padel.topflysolutions.com/w/booking_123/abc-DEF_123");
  });

  it("supports relative guest waiver URLs", () => {
    expect(buildShortGuestWaiverLink("/waiver/booking_123?token=abc", origin)).toBe(
      "https://padel.topflysolutions.com/w/booking_123/abc",
    );
  });

  it("falls back to a normalized link when it cannot build a short link", () => {
    expect(buildShortGuestWaiverLink("/manage/booking_123", origin)).toBe(
      "https://padel.topflysolutions.com/manage/booking_123",
    );
  });
});
