import { NextRequest } from "next/server";
import { z } from "zod";
import { AppError, jsonResponse, routeError } from "@/lib/errors";
import { assertRateLimit, assertTrustedOrigin } from "@/lib/request-guard";
import {
  cancelGuestWaiverSignature,
  getGuestWaiverCancelContext,
} from "@/lib/waiver-service";

const tokenSchema = z.string().trim().min(1).max(200);

type RouteContext = {
  params: Promise<{ signatureId: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    await assertRateLimit(request, "waiver:cancel");
    const { signatureId } = await context.params;
    const tokenValue = request.nextUrl.searchParams.get("token");
    if (!tokenValue) {
      throw new AppError("Link rinuncia posto non valido o scaduto.", 403);
    }

    const cancel = await getGuestWaiverCancelContext(signatureId, tokenSchema.parse(tokenValue));
    return jsonResponse({ cancel });
  } catch (error) {
    return routeError(error);
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    assertTrustedOrigin(request);
    await assertRateLimit(request, "waiver:cancel");
    const { signatureId } = await context.params;
    const body = z.object({ token: tokenSchema }).parse(await request.json());
    const cancel = await cancelGuestWaiverSignature(signatureId, body.token);

    return jsonResponse({ cancel });
  } catch (error) {
    return routeError(error);
  }
}
