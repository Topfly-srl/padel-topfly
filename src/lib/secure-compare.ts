import { createHash, timingSafeEqual } from "crypto";

// Confronto a tempo costante fra due stringhe (es. il secret del cron interno). Stesso schema di
// manage-token.ts: si passa da sha256 cosi' i due buffer hanno SEMPRE la stessa lunghezza (32 byte)
// e timingSafeEqual non lancia mai, nemmeno quando gli input hanno lunghezze diverse. L'hash serve
// solo a normalizzare la lunghezza: la protezione dal timing e' data da timingSafeEqual.
export function timingSafeStringEqual(a: string, b: string): boolean {
  const expected = createHash("sha256").update(a).digest();
  const actual = createHash("sha256").update(b).digest();

  return timingSafeEqual(expected, actual);
}
