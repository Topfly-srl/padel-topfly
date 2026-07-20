import { NextRequest } from "next/server";
import { getAvailability } from "@/lib/booking-service";
import { jsonResponse, routeError } from "@/lib/errors";
import { assertRateLimit } from "@/lib/request-guard";
import { getCurrentUser } from "@/lib/server-auth";

export async function GET(request: NextRequest) {
  try {
    await assertRateLimit(request, "availability:read");
    const date = request.nextUrl.searchParams.get("date");
    // Il refresh lato client dell'admin passa di qui: risolviamo il viewer per restituirgli il
    // nome intero, mentre a chi non e' autenticato resta il calendario pubblico con l'iniziale.
    const user = await getCurrentUser();
    const availability = await getAvailability(date, user);

    return jsonResponse(availability);
  } catch (error) {
    return routeError(error);
  }
}
