import { z } from "zod";
import { isEmailAtDomain, normalizeAllowedDomain } from "@/lib/email";

const optionalUrl = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().url().optional(),
);

const envSchema = z.object({
  APP_ENV: z.enum(["development", "production"]).optional(),
  APP_ALLOWED_DOMAIN: z.string().default("azienda.it"),
  APP_ADMIN_EMAILS: z.string().default(""),
  APP_PUBLIC_ORIGIN: optionalUrl,
  APP_TIME_ZONE: z.string().default("Europe/Rome"),
  AUTH_DEV_MODE: z.string().default("false"),
  DEV_USER_EMAIL: z.string().default("dev@azienda.it"),
  DEV_USER_NAME: z.string().default("Dev Admin"),
  MICROSOFT_ENTRA_ID_ID: z.string().optional(),
  MICROSOFT_ENTRA_ID_SECRET: z.string().optional(),
  MICROSOFT_ENTRA_ID_TENANT_ID: z.string().optional(),
  MS_GRAPH_TENANT_ID: z.string().optional(),
  MS_GRAPH_CLIENT_ID: z.string().optional(),
  MS_GRAPH_CLIENT_SECRET: z.string().optional(),
  MS_GRAPH_MAILBOX: z.string().optional(),
  APP_WAIVER_RECIPIENT_EMAIL: z.string().email().default("padel@topflysolutions.com"),
  APP_WAIVER_DOCUMENT_VERSION: z.string().default("padel-waiver-v1"),
  DATABASE_URL: z.string().optional(),
});

const env = envSchema.parse(process.env);
const appEnvironment = env.APP_ENV ?? "development";
const isProductionDeployment =
  process.env.VERCEL_ENV === "production" ||
  env.APP_ENV === "production" ||
  // `next start` (build di produzione, incluso il container Docker/AWS) imposta NODE_ENV=production.
  // Lo includiamo per evitare che un deploy senza APP_ENV giri in modalita' "development"
  // disattivando auth, header di sicurezza e controllo strict-origin.
  process.env.NODE_ENV === "production";

// Durante `next build` Next imposta NODE_ENV=production ma i segreti di runtime non ci sono
// (e non devono esserci in CI): i controlli fail-fast valgono solo a runtime, non in build.
const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";
const enforceProductionEnv = isProductionDeployment && !isBuildPhase;

if (enforceProductionEnv && env.AUTH_DEV_MODE === "true") {
  throw new Error("AUTH_DEV_MODE non puo' essere attivo in produzione.");
}

if (enforceProductionEnv && !env.DATABASE_URL) {
  throw new Error("DATABASE_URL e' obbligatorio in produzione.");
}

if (enforceProductionEnv) {
  const missingProductionEnv = [
    ["APP_PUBLIC_ORIGIN", env.APP_PUBLIC_ORIGIN],
    ["APP_ADMIN_EMAILS", env.APP_ADMIN_EMAILS.trim()],
    ["MICROSOFT_ENTRA_ID_ID", env.MICROSOFT_ENTRA_ID_ID],
    ["MICROSOFT_ENTRA_ID_SECRET", env.MICROSOFT_ENTRA_ID_SECRET],
    ["MICROSOFT_ENTRA_ID_TENANT_ID", env.MICROSOFT_ENTRA_ID_TENANT_ID],
    ["MS_GRAPH_TENANT_ID", env.MS_GRAPH_TENANT_ID],
    ["MS_GRAPH_CLIENT_ID", env.MS_GRAPH_CLIENT_ID],
    ["MS_GRAPH_CLIENT_SECRET", env.MS_GRAPH_CLIENT_SECRET],
    ["MS_GRAPH_MAILBOX", env.MS_GRAPH_MAILBOX],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missingProductionEnv.length > 0) {
    throw new Error(
      `Configurazione produzione incompleta: ${missingProductionEnv.join(", ")}.`,
    );
  }
}

export const appConfig = {
  allowedDomain: normalizeAllowedDomain(env.APP_ALLOWED_DOMAIN),
  adminEmails: new Set(
    env.APP_ADMIN_EMAILS.split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  ),
  publicOrigin: env.APP_PUBLIC_ORIGIN?.trim().replace(/\/$/, ""),
  timeZone: env.APP_TIME_ZONE,
  isProduction: isProductionDeployment,
  environmentName: appEnvironment,
  authDevMode: env.AUTH_DEV_MODE === "true",
  databaseConfigured: Boolean(env.DATABASE_URL),
  devUser: {
    email: env.DEV_USER_EMAIL.trim().toLowerCase(),
    name: env.DEV_USER_NAME,
  },
  microsoft: {
    clientId: env.MICROSOFT_ENTRA_ID_ID,
    clientSecret: env.MICROSOFT_ENTRA_ID_SECRET,
    tenantId: env.MICROSOFT_ENTRA_ID_TENANT_ID,
  },
  graph: {
    tenantId: env.MS_GRAPH_TENANT_ID,
    clientId: env.MS_GRAPH_CLIENT_ID,
    clientSecret: env.MS_GRAPH_CLIENT_SECRET,
    mailbox: env.MS_GRAPH_MAILBOX,
  },
  waiver: {
    recipientEmail: env.APP_WAIVER_RECIPIENT_EMAIL.trim().toLowerCase(),
    documentVersion: env.APP_WAIVER_DOCUMENT_VERSION.trim(),
  },
};

export function isAllowedCompanyEmail(email: string) {
  return isEmailAtDomain(email, appConfig.allowedDomain);
}

export function isAdminEmail(email: string) {
  return appConfig.adminEmails.has(email.toLowerCase());
}

export function hasMicrosoftAuthConfig() {
  return Boolean(
    appConfig.microsoft.clientId &&
      appConfig.microsoft.clientSecret &&
      appConfig.microsoft.tenantId,
  );
}

export function hasGraphConfig() {
  return Boolean(
    appConfig.graph.tenantId &&
      appConfig.graph.clientId &&
      appConfig.graph.clientSecret &&
      appConfig.graph.mailbox,
  );
}
