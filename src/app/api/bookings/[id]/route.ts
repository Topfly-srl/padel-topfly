import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { cancelBooking, updateBooking } from "@/lib/booking-service";
import { routeError } from "@/lib/errors";
import { getCurrentUser } from "@/lib/server-auth";
import { toDateOrThrow } from "@/lib/time";

const updateBookingSchema = z.object({
  start: z.string().optional(),
  end: z.string().optional(),
  status: z.enum(["CONFIRMED", "CANCELED"]).optional(),
  manageToken: z.string().optional(),
});

const deleteBookingSchema = z.object({
  manageToken: z.string().optional(),
});

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const user = await getCurrentUser();
    const { id } = await context.params;
    const body = updateBookingSchema.parse(await request.json());
    const booking = await updateBooking(
      {
        adminUser: user?.role === "ADMIN" ? user : null,
        manageToken: body.manageToken,
        baseUrl: request.nextUrl.origin,
      },
      id,
      {
        start: body.start ? toDateOrThrow(body.start, "Inizio") : undefined,
        end: body.end ? toDateOrThrow(body.end, "Fine") : undefined,
        status: body.status,
      },
    );

    return NextResponse.json({ booking });
  } catch (error) {
    return routeError(error);
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  try {
    const request = _request;
    const user = await getCurrentUser();
    const { id } = await context.params;
    const body = deleteBookingSchema.parse((await request.json().catch(() => ({}))) ?? {});
    const booking = await cancelBooking(
      {
        adminUser: user?.role === "ADMIN" ? user : null,
        manageToken: body.manageToken ?? request.nextUrl.searchParams.get("token"),
        baseUrl: request.nextUrl.origin,
      },
      id,
    );

    return NextResponse.json({ booking });
  } catch (error) {
    return routeError(error);
  }
}
