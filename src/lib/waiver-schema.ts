import { z } from "zod";
import { isoDateOnlySchema } from "@/lib/date-only";

export const signatureImageDataUrlSchema = z
  .string()
  .min(1, "Disegna la firma nel riquadro.")
  .max(400_000, "La firma disegnata è troppo pesante. Cancella e riprova.");

export const waiverPayloadSchema = z.object({
  birthDate: isoDateOnlySchema,
  birthPlace: z.string().min(2, "Inserisci il luogo di nascita.").max(120),
  isAdultConfirmed: z.boolean(),
  privacyAccepted: z.boolean(),
  regulationAccepted: z.boolean(),
  liabilityAccepted: z.boolean(),
  specificApprovalAccepted: z.boolean(),
  signatureImageDataUrl: signatureImageDataUrlSchema,
});
