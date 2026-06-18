import { createHash } from "crypto";
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { PNG } from "pngjs";
import { generateWaiverPdf } from "@/lib/waiver-pdf";

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

const signatureImageBytes = signaturePngBytes();

const booking = {
  id: "booking_pdf_1",
  start: new Date("2026-06-20T16:00:00.000Z"),
  end: new Date("2026-06-20T17:00:00.000Z"),
  playerCount: 4,
  waiverRevision: 1,
};

const signer = {
  role: "ORGANIZER" as const,
  name: "Mario Rossi",
  email: "mario.rossi@example.com",
  birthDate: new Date("1990-01-01T00:00:00.000Z"),
  birthPlace: "Pretoro",
  signatureText: "Mario Rossi",
  signatureImageBytes,
  signatureImageSha256: createHash("sha256").update(signatureImageBytes).digest("hex"),
};

describe("waiver PDF", () => {
  it("genera un PDF firmato con hash verificabile", async () => {
    const input = {
      booking,
      signer,
      signedAt: new Date("2026-06-17T10:00:00.000Z"),
      documentVersion: "padel-waiver-v1",
      ipHash: "ip-hash",
      userAgentHash: "ua-hash",
    };

    const first = await generateWaiverPdf(input);
    expect(Buffer.from(first.bytes).subarray(0, 4).toString("utf8")).toBe("%PDF");
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(createHash("sha256").update(Buffer.from(first.bytes)).digest("hex")).toBe(first.sha256);

    const doc = await PDFDocument.load(first.bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(3);
  });

  it("incorpora la firma disegnata nel PDF", async () => {
    const generated = await generateWaiverPdf({
      booking,
      signer,
      signedAt: new Date("2026-06-17T10:00:00.000Z"),
      documentVersion: "padel-waiver-v1",
      ipHash: "ip-hash",
      userAgentHash: "ua-hash",
    });

    expect(Buffer.from(generated.bytes).toString("latin1")).toContain("/Image");
  });

  it("mantiene caratteri italiani comuni nei dati firmatario", async () => {
    const generated = await generateWaiverPdf({
      booking,
      signer: {
        ...signer,
        name: "Giulia D'Ambròsi",
        birthPlace: "Città Sant'Angelo",
        signatureText: "Giulia D'Ambròsi",
      },
      signedAt: new Date("2026-06-17T10:00:00.000Z"),
      documentVersion: "padel-waiver-v1",
      ipHash: "ip-hash",
      userAgentHash: "ua-hash",
    });

    expect(Buffer.from(generated.bytes).subarray(0, 4).toString("utf8")).toBe("%PDF");
    await expect(PDFDocument.load(generated.bytes)).resolves.toBeTruthy();
  });
});
