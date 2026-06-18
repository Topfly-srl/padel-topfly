import { NextRequest } from "next/server";
import { z } from "zod";
import { isoDateOnlySchema } from "@/lib/date-only";
import { jsonResponse, routeError } from "@/lib/errors";
import { assertRateLimit, assertTrustedOrigin, clientIp } from "@/lib/request-guard";
import { signGuestWaiver } from "@/lib/waiver-service";

const signWaiverSchema = z.object({
  token: z.string().trim().min(1).max(200),
  signerName: z.string().min(1, "Inserisci nome e cognome.").max(80),
  signerEmail: z.string().email("Inserisci un'email valida.").max(120),
  birthDate: isoDateOnlySchema,
  birthPlace: z.string().min(2, "Inserisci il luogo di nascita.").max(120),
  isAdultConfirmed: z.boolean(),
  privacyAccepted: z.boolean(),
  regulationAccepted: z.boolean(),
  liabilityAccepted: z.boolean(),
  specificApprovalAccepted: z.boolean(),
  signatureImageDataUrl: z.string().min(1, "Disegna la firma nel riquadro.").max(400_000),
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
    );

    return jsonResponse({ waiver }, { status: 201 });
  } catch (error) {
    return routeError(error);
  }
}
