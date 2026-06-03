import { createHash, randomBytes, timingSafeEqual } from "crypto";

export function createManageToken() {
  return randomBytes(32).toString("base64url");
}

export function hashManageToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function manageTokenExpiresAt(end: Date) {
  return new Date(end.getTime() + 24 * 60 * 60 * 1000);
}

export function isManageTokenValid(
  booking: { manageTokenHash: string | null; manageTokenExpiresAt: Date | null },
  token: string | null | undefined,
  now = new Date(),
) {
  if (!booking.manageTokenHash || !booking.manageTokenExpiresAt || !token) {
    return false;
  }

  if (booking.manageTokenExpiresAt < now) {
    return false;
  }

  const expected = Buffer.from(booking.manageTokenHash, "hex");
  const actual = Buffer.from(hashManageToken(token), "hex");

  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function normalizePersonName(name: string) {
  return name.trim().replace(/\s+/g, " ");
}
