import { NextRequest } from "next/server";
import { jsonResponse, routeError } from "@/lib/errors";
import { assertRateLimit, assertTrustedOrigin } from "@/lib/request-guard";
import { assertAdmin, requireApiUser } from "@/lib/server-auth";
import { retryWaiverEmail } from "@/lib/waiver-service";

type RouteContext = {
  params: Promise<{ signatureId: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    assertTrustedOrigin(request);
    const user = await requireApiUser();
    assertAdmin(user);
    await assertRateLimit(request, "admin:waiver-email-retry", user.email);
    const { signatureId } = await context.params;
    const signature = await retryWaiverEmail(signatureId, user);

    return jsonResponse({ signature });
  } catch (error) {
    return routeError(error);
  }
}
