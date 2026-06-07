import { getAdminAudit } from "@/lib/booking-service";
import { jsonResponse, routeError } from "@/lib/errors";
import { assertAdmin, requireApiUser } from "@/lib/server-auth";

export async function GET() {
  try {
    const user = await requireApiUser();
    assertAdmin(user);

    const audit = await getAdminAudit();
    return jsonResponse({ audit });
  } catch (error) {
    return routeError(error);
  }
}
