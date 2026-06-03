import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminBlock } from "@/lib/booking-service";
import { routeError } from "@/lib/errors";
import { assertAdmin, requireApiUser } from "@/lib/server-auth";
import { toDateOrThrow } from "@/lib/time";

const createBlockSchema = z.object({
  start: z.string(),
  end: z.string(),
  reason: z.string().min(1),
});

export async function POST(request: NextRequest) {
  try {
    const user = await requireApiUser();
    assertAdmin(user);

    const body = createBlockSchema.parse(await request.json());
    const block = await createAdminBlock(user, {
      start: toDateOrThrow(body.start, "Inizio"),
      end: toDateOrThrow(body.end, "Fine"),
      reason: body.reason,
    });

    return NextResponse.json({ block }, { status: 201 });
  } catch (error) {
    return routeError(error);
  }
}
