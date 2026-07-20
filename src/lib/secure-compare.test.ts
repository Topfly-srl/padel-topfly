import { describe, expect, it } from "vitest";
import { timingSafeStringEqual } from "@/lib/secure-compare";

describe("timingSafeStringEqual", () => {
  it("riconosce due stringhe identiche", () => {
    expect(timingSafeStringEqual("s3cret-cron-token", "s3cret-cron-token")).toBe(true);
  });

  it("rifiuta stringhe diverse della stessa lunghezza", () => {
    expect(timingSafeStringEqual("aaaaaaaa", "aaaaaaab")).toBe(false);
  });

  it("gestisce lunghezze diverse senza lanciare", () => {
    expect(() => timingSafeStringEqual("corto", "molto-piu-lungo-di-cosi")).not.toThrow();
    expect(timingSafeStringEqual("corto", "molto-piu-lungo-di-cosi")).toBe(false);
  });

  it("tratta la stringa vuota come non corrispondente a un secret", () => {
    expect(timingSafeStringEqual("", "secret")).toBe(false);
    expect(timingSafeStringEqual("secret", "")).toBe(false);
  });

  it("e' sensibile a maiuscole e spazi", () => {
    expect(timingSafeStringEqual("Secret", "secret")).toBe(false);
    expect(timingSafeStringEqual("secret ", "secret")).toBe(false);
  });
});
