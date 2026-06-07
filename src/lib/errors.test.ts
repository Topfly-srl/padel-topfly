import { describe, expect, it } from "vitest";
import { z } from "zod";
import { jsonResponse, routeError } from "@/lib/errors";

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
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("applica no-store alle risposte JSON API", () => {
    const response = jsonResponse({ ok: true });

    expect(response.headers.get("cache-control")).toContain("no-store");
  });
});
