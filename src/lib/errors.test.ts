import { describe, expect, it } from "vitest";
import { z } from "zod";
import { routeError } from "@/lib/errors";

describe("route errors", () => {
  it("restituisce 422 per payload Zod non validi", async () => {
    let error: unknown;

    try {
      z.object({ email: z.string().email("Email non valida.") }).parse({ email: "no" });
    } catch (caught) {
      error = caught;
    }

    const response = routeError(error);

    await expect(response.json()).resolves.toEqual({ error: "Email non valida." });
    expect(response.status).toBe(422);
  });
});
