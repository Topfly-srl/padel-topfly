import { createHash } from "crypto";
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { generateWaiverPdf } from "@/lib/waiver-pdf";

const signatureImageBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

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
