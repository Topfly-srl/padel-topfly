import { getAdminStats } from "@/lib/booking-service";
import { jsonResponse, routeError } from "@/lib/errors";
import { assertAdmin, requireApiUser } from "@/lib/server-auth";

export async function GET() {
  try {
    const user = await requireApiUser();
    assertAdmin(user);

    const stats = await getAdminStats();
    return jsonResponse({ stats });
  } catch (error) {
    return routeError(error);
  }
}
