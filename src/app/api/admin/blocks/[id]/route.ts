import { NextRequest, NextResponse } from "next/server";
import { deleteAdminBlock } from "@/lib/booking-service";
import { routeError } from "@/lib/errors";
import { assertAdmin, requireApiUser } from "@/lib/server-auth";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function DELETE(_request: NextRequest, context: RouteContext) {
  try {
    const user = await requireApiUser();
    assertAdmin(user);

    const { id } = await context.params;
    const block = await deleteAdminBlock(user, id);

    return NextResponse.json({ block });
  } catch (error) {
    return routeError(error);
  }
}
