import { NextRequest } from "next/server";
import { appConfig } from "@/lib/config";
import { AppError, jsonResponse, routeError } from "@/lib/errors";
import { getPublicBaseUrl } from "@/lib/public-url";
import { timingSafeStringEqual } from "@/lib/secure-compare";
import { processSignatureDeadlines } from "@/lib/signature-workflow";

function assertCronSecret(request: NextRequest) {
  if (!appConfig.internalCronSecret) {
    throw new AppError("Cron interno non configurato.", 503);
  }

  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";

  // Confronto a tempo costante: un === trapelerebbe, carattere per carattere, quanto del secret e'
  // corretto misurando i tempi di risposta. timingSafeStringEqual normalizza la lunghezza via hash.
  if (!token || !timingSafeStringEqual(token, appConfig.internalCronSecret)) {
    throw new AppError("Non autorizzato.", 401);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertCronSecret(request);
    const result = await processSignatureDeadlines({
      baseUrl: getPublicBaseUrl(request),
      // Solo il cron passa heartbeat: la pulizia opportunistica no, altrimenti il traffico
      // utente scriverebbe il battito al posto del cron e ne mascherebbe l'arresto.
      heartbeat: true,
    });

    return jsonResponse({ ok: true, ...result });
  } catch (error) {
    return routeError(error);
  }
}
