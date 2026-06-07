import { createHash } from "crypto";
import { Prisma as PrismaNamespace } from "@prisma/client";
import type { NextRequest } from "next/server";
import { appConfig } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";

type RateLimitAction =
  | "booking:create"
  | "booking:create-email"
  | "booking:lookup"
  | "booking:manage";

const rateLimitPolicy: Record<RateLimitAction, { max: number; windowMs: number }> = {
  "booking:create": { max: 8, windowMs: 5 * 60_000 },
  "booking:create-email": { max: 5, windowMs: 15 * 60_000 },
  "booking:lookup": { max: 40, windowMs: 60_000 },
  "booking:manage": { max: 30, windowMs: 60_000 },
};

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

  if (action === "booking:create-email") {
    return `email:${cleanScope || "unknown"}`;
  }

  return `ip:${clientIp(request)}:${cleanScope || "default"}`;
}

function rateKey(request: NextRequest, action: RateLimitAction, scope?: string) {
  return `v2:${action}:${hash(normalizedRateScope(request, action, scope))}`;
}

function allowedOrigins(request: NextRequest) {
  const origins = [appConfig.publicOrigin];

  if (!appConfig.isProduction || !appConfig.publicOrigin) {
    origins.push(request.nextUrl.origin);
  }

  return new Set(
    origins
      .filter((origin): origin is string => Boolean(origin))
      .map((origin) => new URL(origin).origin),
  );
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

export function assertTrustedOrigin(request: NextRequest) {
  const trustedOrigins = allowedOrigins(request);
  const origin = normalizeOrigin(request.headers.get("origin"));

  if (origin) {
    if (!trustedOrigins.has(origin)) {
      throw new AppError("Origine richiesta non autorizzata.", 403);
    }
    return;
  }

  const refererOrigin = normalizeRefererOrigin(request.headers.get("referer"));
  if (refererOrigin && trustedOrigins.has(refererOrigin)) {
    return;
  }

  if (appConfig.isProduction) {
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

  await prisma.$transaction(
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
  );

  if (Math.random() < 0.01) {
    await prisma.rateLimitBucket.deleteMany({
      where: { resetAt: { lt: new Date(now - 24 * 60 * 60_000) } },
    });
  }
}
