import { describe, expect, it } from "vitest";
import { isEmailAtDomain, isExternalEmailForDomain, isValidEmail, normalizeEmailInput } from "@/lib/email";

describe("email helpers", () => {
  it("normalizza casing, spazi e caratteri invisibili", () => {
    expect(normalizeEmailInput("  Mario.Rossi@\u200BTopflySolutions.com\u00A0")).toBe(
      "mario.rossi@topflysolutions.com",
    );
  });

  it("riconosce il dominio aziendale solo su email valide complete", () => {
    expect(isEmailAtDomain("mario.rossi@topflysolutions.com", "topflysolutions.com")).toBe(true);
    expect(isEmailAtDomain("Mario.Rossi@TOPFLYSOLUTIONS.COM", "@topflysolutions.com")).toBe(true);
    expect(isEmailAtDomain("mario@", "topflysolutions.com")).toBe(false);
    expect(isEmailAtDomain("mario.rossi@external.com", "topflysolutions.com")).toBe(false);
  });

  it("mostra email esterna solo se l'indirizzo e' valido ma fuori dominio", () => {
    expect(isExternalEmailForDomain("mario@", "topflysolutions.com")).toBe(false);
    expect(isExternalEmailForDomain("mario.rossi@topflysolutions.com", "topflysolutions.com")).toBe(false);
    expect(isExternalEmailForDomain("mario.rossi@gmail.com", "topflysolutions.com")).toBe(true);
  });

  it("valida usando il valore normalizzato", () => {
    expect(isValidEmail("  mario.rossi@topflysolutions.com  ")).toBe(true);
    expect(isValidEmail("mario rossi@topflysolutions.com")).toBe(false);
  });
});
