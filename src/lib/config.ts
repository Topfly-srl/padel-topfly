import { z } from "zod";

const optionalUrl = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().url().optional(),
);

const envSchema = z.object({
  APP_ENV: z.enum(["development", "preview", "production"]).optional(),
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
  DATABASE_URL: z.string().optional(),
});

const env = envSchema.parse(process.env);
const isProductionDeployment =
  process.env.VERCEL_ENV === "production" || env.APP_ENV === "production";

if (isProductionDeployment && env.AUTH_DEV_MODE === "true") {
  throw new Error("AUTH_DEV_MODE non puo' essere attivo in produzione.");
}

if (isProductionDeployment && !env.DATABASE_URL) {
  throw new Error("DATABASE_URL e' obbligatorio in produzione.");
}

export const appConfig = {
  allowedDomain: env.APP_ALLOWED_DOMAIN.trim().toLowerCase(),
  adminEmails: new Set(
    env.APP_ADMIN_EMAILS.split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  ),
  publicOrigin: env.APP_PUBLIC_ORIGIN?.trim().replace(/\/$/, ""),
  timeZone: env.APP_TIME_ZONE,
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
};

export function isAllowedCompanyEmail(email: string) {
  return email.toLowerCase().endsWith(`@${appConfig.allowedDomain}`);
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
