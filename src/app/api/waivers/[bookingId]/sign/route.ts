import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonResponse, routeError } from "@/lib/errors";
import { assertRateLimit, assertTrustedOrigin, clientIp } from "@/lib/request-guard";
import { getPublicBaseUrl } from "@/lib/public-url";
import { normalizeEmail } from "@/lib/manage-token";
import { signGuestWaiver } from "@/lib/waiver-service";
import { waiverPayloadSchema } from "@/lib/waiver-schema";

const signWaiverSchema = waiverPayloadSchema.extend({
  token: z.string().trim().min(1).max(200),
  signerName: z.string().min(1, "Inserisci nome e cognome.").max(80),
  signerEmail: z.email("Inserisci un'email valida.").max(120),
});

type RouteContext = {
  params: Promise<{ bookingId: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    assertTrustedOrigin(request);
    await assertRateLimit(request, "waiver:sign");
    const { bookingId } = await context.params;
    const body = signWaiverSchema.parse(await request.json());
    await assertRateLimit(request, "waiver:sign-email", normalizeEmail(body.signerEmail));
    const waiver = await signGuestWaiver(
      bookingId,
      body.token,
      {
        signerName: body.signerName,
        signerEmail: body.signerEmail,
        birthDate: body.birthDate,
        birthPlace: body.birthPlace,
        isAdultConfirmed: body.isAdultConfirmed,
        privacyAccepted: body.privacyAccepted,
        regulationAccepted: body.regulationAccepted,
        liabilityAccepted: body.liabilityAccepted,
        specificApprovalAccepted: body.specificApprovalAccepted,
        signatureImageDataUrl: body.signatureImageDataUrl,
      },
      {
        ip: clientIp(request),
        userAgent: request.headers.get("user-agent"),
      },
      getPublicBaseUrl(request),
    );

    return jsonResponse({ waiver }, { status: 201 });
  } catch (error) {
    return routeError(error);
  }
}
