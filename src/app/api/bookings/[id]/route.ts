import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { cancelBooking, updateBooking } from "@/lib/booking-service";
import { routeError } from "@/lib/errors";
import { requireApiUser } from "@/lib/server-auth";
import { toDateOrThrow } from "@/lib/time";

const updateBookingSchema = z.object({
  start: z.string().optional(),
  end: z.string().optional(),
  status: z.enum(["CONFIRMED", "CANCELED"]).optional(),
});

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const body = updateBookingSchema.parse(await request.json());
    const booking = await updateBooking(user, id, {
      start: body.start ? toDateOrThrow(body.start, "Inizio") : undefined,
      end: body.end ? toDateOrThrow(body.end, "Fine") : undefined,
      status: body.status,
    });

    return NextResponse.json({ booking });
  } catch (error) {
    return routeError(error);
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const booking = await cancelBooking(user, id);

    return NextResponse.json({ booking });
  } catch (error) {
    return routeError(error);
  }
}
