import { createHash } from "crypto";
import { networkInterfaces } from "os";
import { Prisma as PrismaNamespace } from "@/generated/prisma/client";
import type { NextRequest } from "next/server";
import { appConfig } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { retryPrismaTransaction } from "@/lib/prisma-retry";

type RateLimitAction =
  | "availability:read"
  | "booking:create"
  | "booking:create-email"
  | "booking:lookup"
  | "booking:manage"
  | "admin:waiver-email-retry"
  | "waiver:cancel"
  | "waiver:read"
  | "waiver:sign"
  | "waiver:sign-email";

const rateLimitPolicy: Record<RateLimitAction, { max: number; windowMs: number }> = {
  // Lettura del calendario per IP: e' un'app aziendale, molti dipendenti condividono lo stesso IP
  // di egress NAT e nei picchi (apertura prenotazioni, pausa pranzo) la somma delle navigazioni
  // per giorno di tutto l'ufficio supererebbe una soglia stretta, restituendo 429 a utenti del
  // tutto legittimi. Cap generoso perche' la lettura e' economica e non muta nulla, ma comunque
  // limitato per fermare uno scraping aggressivo da un singolo IP.
  "availability:read": { max: 300, windowMs: 60_000 },
  "booking:create": { max: 8, windowMs: 5 * 60_000 },
  "booking:create-email": { max: 5, windowMs: 15 * 60_000 },
  "booking:lookup": { max: 40, windowMs: 60_000 },
  "booking:manage": { max: 30, windowMs: 60_000 },
  "admin:waiver-email-retry": { max: 12, windowMs: 15 * 60_000 },
  "waiver:cancel": { max: 20, windowMs: 15 * 60_000 },
  "waiver:read": { max: 60, windowMs: 60_000 },
  "waiver:sign": { max: 10, windowMs: 15 * 60_000 },
  "waiver:sign-email": { max: 8, windowMs: 15 * 60_000 },
};

const emailScopedActions = new Set<RateLimitAction>(["booking:create-email", "waiver:sign-email"]);

const memoryBuckets = new Map<string, { count: number; resetAt: number }>();

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function normalizeHeaderIp(value: string | null) {
  const candidate = value?.trim();
  if (!candidate || candidate.length > 80) return null;
  if (!/^[0-9a-fA-F:.]+$/.test(candidate)) return null;
  return candidate;
}

export function clientIp(request: NextRequest) {
  const realIp = normalizeHeaderIp(request.headers.get("x-real-ip"));
  if (realIp) return realIp;

  const forwardedFor = request.headers
    .get("x-forwarded-for")
    ?.split(",")
    .map((part) => normalizeHeaderIp(part))
    .find((part): part is string => Boolean(part));

  return forwardedFor ?? "unknown";
}

function normalizedRateScope(request: NextRequest, action: RateLimitAction, scope?: string) {
  const cleanScope = scope?.trim().toLowerCase().slice(0, 200);

  if (emailScopedActions.has(action)) {
    return `email:${cleanScope || "unknown"}`;
  }

  return `ip:${clientIp(request)}:${cleanScope || "default"}`;
}

function rateKey(request: NextRequest, action: RateLimitAction, scope?: string) {
  return `v2:${action}:${hash(normalizedRateScope(request, action, scope))}`;
}

function allowedOrigins(request: NextRequest) {
  const origins = [appConfig.publicOrigin];

  if (!strictOriginMode() || !appConfig.publicOrigin) {
    origins.push(request.nextUrl.origin);
  }

  if (!appConfig.isProduction) {
    origins.push(...localDevelopmentOrigins(request));
  }

  return new Set(
    origins
      .filter((origin): origin is string => Boolean(origin))
      .map((origin) => new URL(origin).origin),
  );
}

function strictOriginMode() {
  return appConfig.isProduction;
}

function localDevelopmentOrigins(request: NextRequest) {
  const protocol = request.nextUrl.protocol || "http:";
  const port = request.nextUrl.port || "3000";
  const origins = new Set([
    `${protocol}//localhost:${port}`,
    `${protocol}//127.0.0.1:${port}`,
    `${protocol}//0.0.0.0:${port}`,
  ]);

  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        origins.add(`${protocol}//${address.address}:${port}`);
      }
    }
  }

  for (const origin of process.env.NEXT_ALLOWED_DEV_ORIGINS?.split(",") ?? []) {
    const value = origin.trim();
    if (!value) continue;
    origins.add(value.startsWith("http://") || value.startsWith("https://") ? value : `${protocol}//${value}`);
  }

  return Array.from(origins);
}

function normalizeOrigin(value: string | null) {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    throw new AppError("Origine richiesta non valida.", 403);
  }
}

function normalizeRefererOrigin(value: string | null) {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function isDevelopmentOrigin(origin: string) {
  try {
    const { hostname, protocol } = new URL(origin);

    if (protocol !== "http:" && protocol !== "https:") return false;

    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname.startsWith("192.168.") ||
      hostname.startsWith("10.") ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
    );
  } catch {
    return false;
  }
}

export function assertTrustedOrigin(request: NextRequest) {
  const trustedOrigins = allowedOrigins(request);
  const origin = normalizeOrigin(request.headers.get("origin"));

  if (origin) {
    if (!trustedOrigins.has(origin)) {
      if (!strictOriginMode() && isDevelopmentOrigin(origin)) {
        return;
      }
      throw new AppError("Origine richiesta non autorizzata.", 403);
    }
    return;
  }

  const refererOrigin = normalizeRefererOrigin(request.headers.get("referer"));
  if (refererOrigin && trustedOrigins.has(refererOrigin)) {
    return;
  }

  if (refererOrigin && !strictOriginMode() && isDevelopmentOrigin(refererOrigin)) {
    return;
  }

  if (strictOriginMode()) {
    throw new AppError("Origine richiesta non autorizzata.", 403);
  }
}

export async function assertRateLimit(request: NextRequest, action: RateLimitAction, scope?: string) {
  const policy = rateLimitPolicy[action];
  const now = Date.now();
  const resetAt = new Date(now + policy.windowMs);
  const key = rateKey(request, action, scope);

  if (!appConfig.databaseConfigured) {
    const bucket = memoryBuckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      memoryBuckets.set(key, { count: 1, resetAt: resetAt.getTime() });
      return;
    }

    if (bucket.count >= policy.max) {
      throw new AppError("Troppe richieste ravvicinate. Riprova tra poco.", 429);
    }

    bucket.count += 1;
    return;
  }

  const nowDate = new Date(now);

  await retryPrismaTransaction(() =>
    prisma.$transaction(
      async (tx) => {
        await tx.rateLimitBucket.deleteMany({
          where: {
            key,
            resetAt: { lte: nowDate },
          },
        });

        const bucket = await tx.rateLimitBucket.upsert({
          where: { key },
          create: { key, count: 1, resetAt },
          update: { count: { increment: 1 } },
        });

        if (bucket.count > policy.max) {
          throw new AppError("Troppe richieste ravvicinate. Riprova tra poco.", 429);
        }
      },
      { isolationLevel: PrismaNamespace.TransactionIsolationLevel.Serializable },
    ),
  );

  if (Math.random() < 0.01) {
    await prisma.rateLimitBucket.deleteMany({
      where: { resetAt: { lt: new Date(now - 24 * 60 * 60_000) } },
    });
  }
}
