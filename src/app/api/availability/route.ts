import { NextRequest, NextResponse } from "next/server";
import { getAvailability } from "@/lib/booking-service";
import { routeError } from "@/lib/errors";
import { requireApiUser } from "@/lib/server-auth";

export async function GET(request: NextRequest) {
  try {
    const user = await requireApiUser();
    const date = request.nextUrl.searchParams.get("date");
    const availability = await getAvailability(date, user);

    return NextResponse.json(availability);
  } catch (error) {
    return routeError(error);
  }
}
