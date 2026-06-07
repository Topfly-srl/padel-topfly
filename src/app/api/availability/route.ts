import { NextRequest } from "next/server";
import { getAvailability } from "@/lib/booking-service";
import { jsonResponse, routeError } from "@/lib/errors";

export async function GET(request: NextRequest) {
  try {
    const date = request.nextUrl.searchParams.get("date");
    const availability = await getAvailability(date);

    return jsonResponse(availability);
  } catch (error) {
    return routeError(error);
  }
}
