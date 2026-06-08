import { describe, expect, it } from "vitest";
import { retryPrismaTransaction } from "@/lib/prisma-retry";

describe("prisma transaction retry", () => {
  it("ritenta i conflitti serializzabili Prisma P2034", async () => {
    let calls = 0;

    const result = await retryPrismaTransaction(async () => {
      calls += 1;

      if (calls === 1) {
        throw { code: "P2034" };
      }

      return "ok";
    });

    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("non ritenta errori non legati a conflitti transazionali", async () => {
    let calls = 0;

    await expect(
      retryPrismaTransaction(async () => {
        calls += 1;
        throw new Error("errore applicativo");
      }),
    ).rejects.toThrow("errore applicativo");

    expect(calls).toBe(1);
  });
});
