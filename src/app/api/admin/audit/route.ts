import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminAudit } from "@/lib/booking-service";
import { jsonResponse, routeError } from "@/lib/errors";
import { assertAdmin, requireApiUser } from "@/lib/server-auth";
import { auditActions } from "@/lib/types";

const querySchema = z.object({
  action: z.enum(auditActions).optional(),
  cursor: z.string().trim().max(300).optional(),
  limit: z.coerce.number().int().min(10).max(100).default(40),
});

export async function GET(request: NextRequest) {
  try {
    const user = await requireApiUser();
    assertAdmin(user);

    const query = querySchema.parse({
      action: request.nextUrl.searchParams.get("action") ?? undefined,
      cursor: request.nextUrl.searchParams.get("cursor") ?? undefined,
      limit: request.nextUrl.searchParams.get("limit") ?? undefined,
    });
    const page = await getAdminAudit(query);

    return jsonResponse({ audit: page.items, nextCursor: page.nextCursor });
  } catch (error) {
    return routeError(error);
  }
}
