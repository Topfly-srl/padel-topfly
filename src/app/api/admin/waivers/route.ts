import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonResponse, routeError } from "@/lib/errors";
import { assertAdmin, requireApiUser } from "@/lib/server-auth";
import { listAdminWaiverSignatures } from "@/lib/waiver-service";

const querySchema = z.object({
  status: z.enum(["PENDING", "SENT", "FAILED", "SKIPPED"]).optional(),
  role: z.enum(["ORGANIZER", "GUEST"]).optional(),
  query: z.string().trim().max(80).optional(),
  cursor: z.string().trim().max(300).optional(),
  limit: z.coerce.number().int().min(10).max(100).default(50),
});

export async function GET(request: NextRequest) {
  try {
    const user = await requireApiUser();
    assertAdmin(user);
    const query = querySchema.parse({
      status: request.nextUrl.searchParams.get("status") ?? undefined,
      role: request.nextUrl.searchParams.get("role") ?? undefined,
      query: request.nextUrl.searchParams.get("query") ?? undefined,
      cursor: request.nextUrl.searchParams.get("cursor") ?? undefined,
      limit: request.nextUrl.searchParams.get("limit") ?? undefined,
    });
    const list = await listAdminWaiverSignatures(query);

    return jsonResponse({ waivers: list.items, nextCursor: list.nextCursor });
  } catch (error) {
    return routeError(error);
  }
}
