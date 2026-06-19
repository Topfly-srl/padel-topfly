import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PNG } from "pngjs";
import { demoCreateBooking, demoGetWaiverContext, demoReset, demoSignGuestWaiver } from "@/lib/demo-store";
import {
  normalizeWaiverInput,
  summarizeWaiverSignatures,
  validatePlayerCount,
  type WaiverInput,
} from "@/lib/waiver-service";

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

function blankPngDataUrl() {
  const png = new PNG({ width: 260, height: 100 });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = 255;
    png.data[index + 1] = 255;
    png.data[index + 2] = 255;
    png.data[index + 3] = 255;
  }
  return `data:image/png;base64,${PNG.sync.write(png).toString("base64")}`;
}

const signatureImageDataUrl = `data:image/png;base64,${signaturePngBytes().toString("base64")}`;

const validWaiver: WaiverInput = {
  signerName: "Mario Rossi",
  signerEmail: "mario.rossi@example.com",
  birthDate: new Date("1990-01-01T00:00:00.000Z"),
  birthPlace: "Pretoro",
  isAdultConfirmed: true,
  privacyAccepted: true,
  regulationAccepted: true,
  liabilityAccepted: true,
  specificApprovalAccepted: true,
  signatureText: "Mario Rossi",
  signatureImageDataUrl,
};

function futureSlot() {
  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(18, 0, 0, 0);
  const end = new Date(start.getTime() + 60 * 60_000);
  return { start, end };
}

describe("waiver service", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    demoReset();
  });

  it("valida player count solo tra 2 e 4", () => {
    expect(validatePlayerCount(2)).toBe(2);
    expect(validatePlayerCount(4)).toBe(4);
    expect(() => validatePlayerCount(1)).toThrow("numero giocatori");
    expect(() => validatePlayerCount(5)).toThrow("numero giocatori");
  });

  it("richiede consensi, maggior eta' e firma disegnata", () => {
    expect(normalizeWaiverInput(validWaiver).signerEmail).toBe("mario.rossi@example.com");

    expect(() =>
      normalizeWaiverInput({
        ...validWaiver,
        regulationAccepted: false,
      }),
    ).toThrow("regolamento");

    expect(() =>
      normalizeWaiverInput({
        ...validWaiver,
        signatureImageDataUrl: "",
      }),
    ).toThrow("Disegna la firma");

    expect(() =>
      normalizeWaiverInput({
        ...validWaiver,
        signatureImageDataUrl: "data:image/jpeg;base64,abcd",
      }),
    ).toThrow("PNG");

    expect(() =>
      normalizeWaiverInput({
        ...validWaiver,
        signatureImageDataUrl: blankPngDataUrl(),
      }),
    ).toThrow("firma valida");

    expect(() =>
      normalizeWaiverInput(
        {
          ...validWaiver,
          birthDate: new Date("2020-01-01T00:00:00.000Z"),
        },
        new Date("2026-06-17T10:00:00.000Z"),
      ),
    ).toThrow("maggiorenni");
  });

  it("fa firmare gli ospiti fino al numero giocatori previsto", async () => {
    const booking = await demoCreateBooking({
      ...futureSlot(),
      organizerName: "Mario Rossi",
      organizerEmail: "mario@example.com",
      playerCount: 2,
      waiver: validWaiver,
      baseUrl: "https://padel.example.com",
    });

    expect(booking.guestWaiverUrl).toContain(`/waiver/${booking.id}?token=`);

    const token = booking.guestWaiverToken!;
    const before = await demoGetWaiverContext(booking.id, token);
    expect(before.booking.waiverSignedCount).toBe(1);
    expect(before.booking.remainingSignatures).toBe(1);

    await demoSignGuestWaiver(
      booking.id,
      token,
      {
        ...validWaiver,
        signerName: "Laura Bianchi",
        signerEmail: "laura@example.com",
        signatureText: "Laura Bianchi",
      },
      {},
    );

    const after = await demoGetWaiverContext(booking.id, token);
    expect(after.booking.waiverSignedCount).toBe(2);
    expect(after.booking.remainingSignatures).toBe(0);

    await expect(
      demoSignGuestWaiver(
        booking.id,
        token,
        {
          ...validWaiver,
          signerName: "Paolo Neri",
          signerEmail: "paolo@example.com",
          signatureText: "Paolo Neri",
        },
        {},
      ),
    ).rejects.toThrow("Tutte le firme");
  });

  it("blocca una seconda firma sulla stessa prenotazione con la stessa email", async () => {
    const booking = await demoCreateBooking({
      ...futureSlot(),
      organizerName: "Mario Rossi",
      organizerEmail: "mario@example.com",
      playerCount: 4,
      waiver: validWaiver,
      baseUrl: "https://padel.example.com",
    });

    const token = booking.guestWaiverToken!;
    const guestWaiver = {
      ...validWaiver,
      signerName: "Laura Bianchi",
      signerEmail: "laura@example.com",
      signatureText: "Laura Bianchi",
    };

    await demoSignGuestWaiver(booking.id, token, guestWaiver, {});
    await expect(demoSignGuestWaiver(booking.id, token, guestWaiver, {})).rejects.toThrow("gia' firmato");
  });

  it("non conta le firme ospite rinunciate nel totale firme", () => {
    const summary = summarizeWaiverSignatures({
      playerCount: 4,
      waiverRevision: 1,
      waiverSignatures: [
        { bookingRevision: 1, emailStatus: "SENT", status: "ACTIVE" },
        { bookingRevision: 1, emailStatus: "SENT", status: "ACTIVE" },
        { bookingRevision: 1, emailStatus: "SENT", status: "CANCELED" },
        { bookingRevision: 2, emailStatus: "SENT", status: "ACTIVE" },
      ],
    });

    expect(summary.signedCount).toBe(2);
    expect(summary.remainingCount).toBe(2);
    expect(summary.emailStatus).toBe("SENT");
  });

  it("genera link firma ospiti e rinuncia senza marcatori di test", async () => {
    const { buildGuestWaiverCancelUrl, buildGuestWaiverUrl } = await import("@/lib/waiver-service");

    expect(buildGuestWaiverUrl("https://padel.topflysolutions.com", "booking_1", "abc")).toBe(
      "https://padel.topflysolutions.com/waiver/booking_1?token=abc",
    );
    expect(buildGuestWaiverCancelUrl("https://padel.topflysolutions.com", "waiver_1", "cancel")).toBe(
      "https://padel.topflysolutions.com/waiver/cancel/waiver_1?token=cancel",
    );
  });
});
