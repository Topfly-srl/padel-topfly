import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createBooking, listBookings } from "@/lib/booking-service";
import { routeError } from "@/lib/errors";
import { requireApiUser } from "@/lib/server-auth";
import { toDateOrThrow } from "@/lib/time";

const createBookingSchema = z.object({
  start: z.string(),
  end: z.string(),
});

export async function GET() {
  try {
    const user = await requireApiUser();
    const bookings = await listBookings(user);

    return NextResponse.json({ bookings });
  } catch (error) {
    return routeError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireApiUser();
    const body = createBookingSchema.parse(await request.json());
    const booking = await createBooking(user, {
      start: toDateOrThrow(body.start, "Inizio"),
      end: toDateOrThrow(body.end, "Fine"),
    });

    return NextResponse.json({ booking }, { status: 201 });
  } catch (error) {
    return routeError(error);
  }
}
