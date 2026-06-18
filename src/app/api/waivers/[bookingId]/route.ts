import { NextRequest } from "next/server";
import { z } from "zod";
import { AppError, jsonResponse, routeError } from "@/lib/errors";
import { assertRateLimit } from "@/lib/request-guard";
import { getWaiverContext } from "@/lib/waiver-service";

const tokenSchema = z.string().trim().min(1).max(200);

type RouteContext = {
  params: Promise<{ bookingId: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    await assertRateLimit(request, "waiver:read");
    const { bookingId } = await context.params;
    const tokenValue = request.nextUrl.searchParams.get("token");
    if (!tokenValue) {
      throw new AppError("Link firma ospiti non valido o scaduto.", 403);
    }
    const token = tokenSchema.parse(tokenValue);
    const waiver = await getWaiverContext(bookingId, token);

    return jsonResponse({ waiver });
  } catch (error) {
    return routeError(error);
  }
}
