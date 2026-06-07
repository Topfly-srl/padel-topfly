import { afterEach, describe, expect, it, vi } from "vitest";

function stubProductionEnv(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.stubEnv("APP_ENV", "production");
  vi.stubEnv("DATABASE_URL", "postgres://user:pass@localhost:5432/db");
  vi.stubEnv("APP_PUBLIC_ORIGIN", "https://padel.topflysolutions.com");
  vi.stubEnv("APP_ADMIN_EMAILS", "admin@topflysolutions.com");
  vi.stubEnv("MICROSOFT_ENTRA_ID_ID", "client-id");
  vi.stubEnv("MICROSOFT_ENTRA_ID_SECRET", "client-secret");
  vi.stubEnv("MICROSOFT_ENTRA_ID_TENANT_ID", "tenant-id");
  vi.stubEnv("MS_GRAPH_TENANT_ID", "tenant-id");
  vi.stubEnv("MS_GRAPH_CLIENT_ID", "graph-client-id");
  vi.stubEnv("MS_GRAPH_CLIENT_SECRET", "graph-client-secret");
  vi.stubEnv("MS_GRAPH_MAILBOX", "padel@topflysolutions.com");

  for (const [key, value] of Object.entries(overrides)) {
    vi.stubEnv(key, value);
  }
}

describe("app config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("rifiuta produzione senza env critiche", async () => {
    stubProductionEnv({ APP_PUBLIC_ORIGIN: undefined });

    await expect(import("@/lib/config")).rejects.toThrow("APP_PUBLIC_ORIGIN");
  });

  it("accetta produzione con env critiche presenti", async () => {
    stubProductionEnv();

    const { appConfig } = await import("@/lib/config");

    expect(appConfig.isProduction).toBe(true);
    expect(appConfig.publicOrigin).toBe("https://padel.topflysolutions.com");
  });
});
