import { NextRequest } from "next/server";
import { z } from "zod";
import { createBooking, listBookings } from "@/lib/booking-service";
import { isoDateOnlySchema } from "@/lib/date-only";
import { jsonResponse, routeError } from "@/lib/errors";
import { normalizeEmail } from "@/lib/manage-token";
import { getPublicBaseUrl } from "@/lib/public-url";
import { assertRateLimit, assertTrustedOrigin, clientIp } from "@/lib/request-guard";
import { assertAdmin, requireApiUser } from "@/lib/server-auth";
import { toDateOrThrow } from "@/lib/time";

const waiverSchema = z.object({
  birthDate: isoDateOnlySchema,
  birthPlace: z.string().min(2, "Inserisci il luogo di nascita.").max(120),
  isAdultConfirmed: z.boolean(),
  privacyAccepted: z.boolean(),
  regulationAccepted: z.boolean(),
  liabilityAccepted: z.boolean(),
  specificApprovalAccepted: z.boolean(),
  signatureImageDataUrl: z.string().min(1, "Disegna la firma nel riquadro.").max(400_000),
});

const createBookingSchema = z.object({
  start: z.string(),
  end: z.string(),
  organizerName: z.string().min(1, "Inserisci nome e cognome.").max(80),
  organizerEmail: z.string().email("Inserisci un'email valida.").max(120),
  playerCount: z.number().int().min(2).max(4),
  waiver: waiverSchema,
});

export async function GET() {
  try {
    const user = await requireApiUser();
    assertAdmin(user);
    const bookings = await listBookings(user);

    return jsonResponse({ bookings });
  } catch (error) {
    return routeError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertTrustedOrigin(request);
    await assertRateLimit(request, "booking:create");

    const body = createBookingSchema.parse(await request.json());
    await assertRateLimit(request, "booking:create-email", normalizeEmail(body.organizerEmail));

    const booking = await createBooking({
      start: toDateOrThrow(body.start, "Inizio"),
      end: toDateOrThrow(body.end, "Fine"),
      organizerName: body.organizerName,
      organizerEmail: body.organizerEmail,
      playerCount: body.playerCount,
      waiver: {
        ...body.waiver,
        signerName: body.organizerName,
        signerEmail: body.organizerEmail,
      },
      waiverEvidence: {
        ip: clientIp(request),
        userAgent: request.headers.get("user-agent"),
      },
      baseUrl: getPublicBaseUrl(request),
    });

    return jsonResponse({ booking }, { status: 201 });
  } catch (error) {
    return routeError(error);
  }
}
