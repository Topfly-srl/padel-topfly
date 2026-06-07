import { NextRequest } from "next/server";
import { z } from "zod";
import { createAdminBlock } from "@/lib/booking-service";
import { jsonResponse, routeError } from "@/lib/errors";
import { assertTrustedOrigin } from "@/lib/request-guard";
import { assertAdmin, requireApiUser } from "@/lib/server-auth";
import { toDateOrThrow } from "@/lib/time";

const createBlockSchema = z.object({
  start: z.string(),
  end: z.string(),
  reason: z.string().trim().min(1, "Inserisci un motivo per il blocco.").max(120),
});

export async function POST(request: NextRequest) {
  try {
    assertTrustedOrigin(request);
    const user = await requireApiUser();
    assertAdmin(user);

    const body = createBlockSchema.parse(await request.json());
    const block = await createAdminBlock(user, {
      start: toDateOrThrow(body.start, "Inizio"),
      end: toDateOrThrow(body.end, "Fine"),
      reason: body.reason,
    });

    return jsonResponse({ block }, { status: 201 });
  } catch (error) {
    return routeError(error);
  }
}
