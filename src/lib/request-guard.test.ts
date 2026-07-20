import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

function makeRequest(headers: Record<string, string> = {}) {
  return new NextRequest("https://padel.topflysolutions.com/api/bookings", {
    method: "POST",
    headers,
  });
}

async function loadGuard(env: "development" | "production") {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", env === "production" ? "production" : "development");
  vi.stubEnv("APP_ENV", env);
  vi.stubEnv("APP_PUBLIC_ORIGIN", "https://padel.topflysolutions.com");
  vi.stubEnv("DATABASE_URL", env === "production" ? "postgres://user:pass@localhost:5432/db" : "");
  vi.stubEnv("APP_ADMIN_EMAILS", "admin@topflysolutions.com");
  vi.stubEnv("MICROSOFT_ENTRA_ID_ID", "client-id");
  vi.stubEnv("MICROSOFT_ENTRA_ID_SECRET", "client-secret");
  vi.stubEnv("MICROSOFT_ENTRA_ID_TENANT_ID", "tenant-id");
  vi.stubEnv("MS_GRAPH_TENANT_ID", "tenant-id");
  vi.stubEnv("MS_GRAPH_CLIENT_ID", "graph-client-id");
  vi.stubEnv("MS_GRAPH_CLIENT_SECRET", "graph-client-secret");
  vi.stubEnv("MS_GRAPH_MAILBOX", "padel@topflysolutions.com");

  return import("@/lib/request-guard");
}

describe("request guard", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("accetta un origin trusted in produzione", async () => {
    const { assertTrustedOrigin } = await loadGuard("production");

    expect(() =>
      assertTrustedOrigin(makeRequest({ origin: "https://padel.topflysolutions.com" })),
    ).not.toThrow();
  });

  it("rifiuta un origin esterno in produzione", async () => {
    const { assertTrustedOrigin } = await loadGuard("production");

    expect(() => assertTrustedOrigin(makeRequest({ origin: "https://evil.example" }))).toThrow(
      "Origine richiesta non autorizzata.",
    );
  });

  it("rifiuta mutazioni senza origin o referer in produzione", async () => {
    const { assertTrustedOrigin } = await loadGuard("production");

    expect(() => assertTrustedOrigin(makeRequest())).toThrow("Origine richiesta non autorizzata.");
  });

  it("accetta un referer same-origin quando manca origin", async () => {
    const { assertTrustedOrigin } = await loadGuard("production");

    expect(() =>
      assertTrustedOrigin(
        makeRequest({ referer: "https://padel.topflysolutions.com/manage/booking-id" }),
      ),
    ).not.toThrow();
  });

  it("accetta origin LAN in sviluppo locale", async () => {
    const { assertTrustedOrigin } = await loadGuard("development");

    expect(() =>
      assertTrustedOrigin(
        new NextRequest("http://localhost:3000/api/bookings", {
          method: "POST",
          headers: { origin: "http://192.168.1.11:3000" },
        }),
      ),
    ).not.toThrow();
  });

  it("preferisce X-Real-IP validato per il rate limit", async () => {
    const { clientIp } = await loadGuard("development");

    expect(
      clientIp(makeRequest({ "x-real-ip": "203.0.113.10", "x-forwarded-for": "198.51.100.5" })),
    ).toBe("203.0.113.10");
  });

  it("limita le creazioni ravvicinate anche per email", async () => {
    const { assertRateLimit } = await loadGuard("development");
    const request = makeRequest({ "x-real-ip": "203.0.113.11" });

    await assertRateLimit(request, "booking:create-email", "rocco@example.com");
    await assertRateLimit(request, "booking:create-email", "rocco@example.com");
    await assertRateLimit(request, "booking:create-email", "rocco@example.com");
    await assertRateLimit(request, "booking:create-email", "rocco@example.com");
    await assertRateLimit(request, "booking:create-email", "rocco@example.com");

    await expect(
      assertRateLimit(request, "booking:create-email", "rocco@example.com"),
    ).rejects.toThrow("Troppe richieste ravvicinate.");
  });

  it("limita le letture ravvicinate della disponibilita' per IP", async () => {
    const { assertRateLimit } = await loadGuard("development");
    const request = makeRequest({ "x-real-ip": "203.0.113.60" });

    for (let index = 0; index < 300; index += 1) {
      await assertRateLimit(request, "availability:read");
    }

    await expect(assertRateLimit(request, "availability:read")).rejects.toThrow(
      "Troppe richieste ravvicinate.",
    );
  });

  it("applica il rate limit email anche se cambia IP", async () => {
    const { assertRateLimit } = await loadGuard("development");

    for (let index = 0; index < 5; index += 1) {
      await assertRateLimit(
        makeRequest({ "x-real-ip": `203.0.113.${index + 20}` }),
        "booking:create-email",
        "stessa.email@example.com",
      );
    }

    await expect(
      assertRateLimit(
        makeRequest({ "x-real-ip": "203.0.113.99" }),
        "booking:create-email",
        "stessa.email@example.com",
      ),
    ).rejects.toThrow("Troppe richieste ravvicinate.");
  });
});
