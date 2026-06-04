import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { lookupBookings } from "@/lib/booking-service";
import { routeError } from "@/lib/errors";
import { assertRateLimit, assertTrustedOrigin } from "@/lib/request-guard";

const lookupSchema = z.object({
  tokens: z.array(z.string().trim().min(1).max(200)).max(30),
});

export async function POST(request: NextRequest) {
  try {
    assertTrustedOrigin(request);
    await assertRateLimit(request, "booking:lookup");

    const body = lookupSchema.parse(await request.json());
    const bookings = await lookupBookings(body.tokens, request.nextUrl.origin);

    return NextResponse.json({ bookings });
  } catch (error) {
    return routeError(error);
  }
}
