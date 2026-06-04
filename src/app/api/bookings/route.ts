import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createBooking, listBookings } from "@/lib/booking-service";
import { routeError } from "@/lib/errors";
import { assertRateLimit, assertTrustedOrigin } from "@/lib/request-guard";
import { assertAdmin, requireApiUser } from "@/lib/server-auth";
import { toDateOrThrow } from "@/lib/time";

const createBookingSchema = z.object({
  start: z.string(),
  end: z.string(),
  organizerName: z.string().min(1, "Inserisci nome e cognome.").max(80),
  organizerEmail: z.string().email("Inserisci un'email valida.").max(120),
});

export async function GET() {
  try {
    const user = await requireApiUser();
    assertAdmin(user);
    const bookings = await listBookings(user);

    return NextResponse.json({ bookings });
  } catch (error) {
    return routeError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertTrustedOrigin(request);
    await assertRateLimit(request, "booking:create");

    const body = createBookingSchema.parse(await request.json());
    const booking = await createBooking({
      start: toDateOrThrow(body.start, "Inizio"),
      end: toDateOrThrow(body.end, "Fine"),
      organizerName: body.organizerName,
      organizerEmail: body.organizerEmail,
      baseUrl: request.nextUrl.origin,
    });

    return NextResponse.json({ booking }, { status: 201 });
  } catch (error) {
    return routeError(error);
  }
}
