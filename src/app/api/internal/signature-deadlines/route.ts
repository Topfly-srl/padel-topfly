import { NextRequest } from "next/server";
import { appConfig } from "@/lib/config";
import { AppError, jsonResponse, routeError } from "@/lib/errors";
import { getPublicBaseUrl } from "@/lib/public-url";
import { processSignatureDeadlines } from "@/lib/signature-workflow";

function assertCronSecret(request: NextRequest) {
  if (!appConfig.internalCronSecret) {
    throw new AppError("Cron interno non configurato.", 503);
  }

  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";

  if (!token || token !== appConfig.internalCronSecret) {
    throw new AppError("Non autorizzato.", 401);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertCronSecret(request);
    const result = await processSignatureDeadlines({
      baseUrl: getPublicBaseUrl(request),
    });

    return jsonResponse({ ok: true, ...result });
  } catch (error) {
    return routeError(error);
  }
}
