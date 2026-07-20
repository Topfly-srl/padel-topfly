import { NextRequest } from "next/server";
import { z } from "zod";
import { cancelBooking, updateBooking } from "@/lib/booking-service";
import { jsonResponse, routeError } from "@/lib/errors";
import { maxCancelReasonLength } from "@/lib/cancel-reason";
import { getPublicBaseUrl } from "@/lib/public-url";
import { assertRateLimit, assertTrustedOrigin } from "@/lib/request-guard";
import { getCurrentUser } from "@/lib/server-auth";
import { toDateOrThrow } from "@/lib/time";

const manageTokenSchema = z.string().trim().min(1).max(200);
const cancelReasonSchema = z.string().trim().max(maxCancelReasonLength);

const updateBookingSchema = z.object({
  start: z.string().optional(),
  end: z.string().optional(),
  status: z.enum(["PENDING_SIGNATURES", "CONFIRMED", "CANCELED"]).optional(),
  playerCount: z.number().int().min(1).max(4).optional(),
  manageToken: manageTokenSchema.optional(),
  cancelReason: cancelReasonSchema.optional(),
});

const deleteBookingSchema = z.object({
  manageToken: manageTokenSchema.optional(),
  cancelReason: cancelReasonSchema.optional(),
});

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    assertTrustedOrigin(request);
    const user = await getCurrentUser();
    const adminUser = user?.role === "ADMIN" ? user : null;
    if (!adminUser) {
      await assertRateLimit(request, "booking:manage");
    }

    const { id } = await context.params;
    const body = updateBookingSchema.parse(await request.json());
    const booking = await updateBooking(
      {
        adminUser,
        manageToken: body.manageToken,
        baseUrl: getPublicBaseUrl(request),
      },
      id,
      {
        start: body.start ? toDateOrThrow(body.start, "Inizio") : undefined,
        end: body.end ? toDateOrThrow(body.end, "Fine") : undefined,
        status: body.status,
        playerCount: body.playerCount,
        cancelReason: body.cancelReason,
      },
    );

    return jsonResponse({ booking });
  } catch (error) {
    return routeError(error);
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    assertTrustedOrigin(request);
    const user = await getCurrentUser();
    const adminUser = user?.role === "ADMIN" ? user : null;
    if (!adminUser) {
      await assertRateLimit(request, "booking:manage");
    }

    const { id } = await context.params;
    const body = deleteBookingSchema.parse((await request.json().catch(() => ({}))) ?? {});
    const queryToken = request.nextUrl.searchParams.get("token");
    const manageToken = body.manageToken ?? (queryToken ? manageTokenSchema.parse(queryToken) : null);
    const booking = await cancelBooking(
      {
        adminUser,
        manageToken,
        baseUrl: getPublicBaseUrl(request),
      },
      id,
      { cancelReason: body.cancelReason },
    );

    return jsonResponse({ booking });
  } catch (error) {
    return routeError(error);
  }
}
