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

  it("ritenta i conflitti dell'adapter pg v7 (DriverAdapterError, SQLSTATE 40001)", async () => {
    let calls = 0;

    // In v7 col driver adapter la serialization failure arriva come DriverAdapterError con
    // `code` undefined e lo SQLSTATE grezzo in `cause.originalCode`. Verificato su Postgres reale.
    const result = await retryPrismaTransaction(async () => {
      calls += 1;

      if (calls === 1) {
        throw Object.assign(new Error("TransactionWriteConflict"), {
          name: "DriverAdapterError",
          cause: {
            originalCode: "40001",
            originalMessage:
              "could not serialize access due to read/write dependencies among transactions",
            kind: "TransactionWriteConflict",
          },
        });
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
