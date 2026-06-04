import { createHash } from "crypto";
import type { NextRequest } from "next/server";
import { appConfig } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";

type RateLimitAction = "booking:create" | "booking:lookup" | "booking:manage";

const rateLimitPolicy: Record<RateLimitAction, { max: number; windowMs: number }> = {
  "booking:create": { max: 8, windowMs: 5 * 60_000 },
  "booking:lookup": { max: 40, windowMs: 60_000 },
  "booking:manage": { max: 30, windowMs: 60_000 },
};

const memoryBuckets = new Map<string, { count: number; resetAt: number }>();

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function clientIp(request: NextRequest) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

function rateKey(request: NextRequest, action: RateLimitAction) {
  return `v1:${action}:${hash(clientIp(request))}`;
}

function allowedOrigins(request: NextRequest) {
  return new Set(
    [request.nextUrl.origin, appConfig.publicOrigin]
      .filter((origin): origin is string => Boolean(origin))
      .map((origin) => new URL(origin).origin),
  );
}

export function assertTrustedOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");

  if (!origin) return;

  let normalizedOrigin: string;
  try {
    normalizedOrigin = new URL(origin).origin;
  } catch {
    throw new AppError("Origine richiesta non valida.", 403);
  }

  if (!allowedOrigins(request).has(normalizedOrigin)) {
    throw new AppError("Origine richiesta non autorizzata.", 403);
  }
}

export async function assertRateLimit(request: NextRequest, action: RateLimitAction) {
  const policy = rateLimitPolicy[action];
  const now = Date.now();
  const resetAt = new Date(now + policy.windowMs);
  const key = rateKey(request, action);

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
  const bucket = await prisma.rateLimitBucket.findUnique({ where: { key } });

  if (!bucket || bucket.resetAt <= nowDate) {
    await prisma.rateLimitBucket.upsert({
      where: { key },
      create: { key, count: 1, resetAt },
      update: { count: 1, resetAt },
    });
    return;
  }

  if (bucket.count >= policy.max) {
    throw new AppError("Troppe richieste ravvicinate. Riprova tra poco.", 429);
  }

  await prisma.rateLimitBucket.update({
    where: { key },
    data: { count: { increment: 1 } },
  });

  if (Math.random() < 0.01) {
    await prisma.rateLimitBucket.deleteMany({
      where: { resetAt: { lt: new Date(now - 24 * 60 * 60_000) } },
    });
  }
}
