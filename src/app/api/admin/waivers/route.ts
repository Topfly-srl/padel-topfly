import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonResponse, routeError } from "@/lib/errors";
import { assertAdmin, requireApiUser } from "@/lib/server-auth";
import { listAdminWaiverSignatures } from "@/lib/waiver-service";

const querySchema = z.object({
  status: z.enum(["PENDING", "SENT", "FAILED", "SKIPPED"]).optional(),
  limit: z.coerce.number().int().min(10).max(200).default(50),
});

export async function GET(request: NextRequest) {
  try {
    const user = await requireApiUser();
    assertAdmin(user);
    const query = querySchema.parse({
      status: request.nextUrl.searchParams.get("status") ?? undefined,
      limit: request.nextUrl.searchParams.get("limit") ?? undefined,
    });
    const waivers = await listAdminWaiverSignatures(query);

    return jsonResponse({ waivers });
  } catch (error) {
    return routeError(error);
  }
}
