import type { BookingStatus, WaiverEmailStatus, WaiverSignerRole } from "@/generated/prisma/client";

// Il PDF dello scarico parte con due mail distinte: "archive" e' la copia verso l'archivio
// legale, "signer" e' la copia al firmatario (solo il referente ne ha una). Tenerle separate
// serve a non far passare per riuscito un invio in cui una delle due non e' arrivata.
export type WaiverMailLeg = "archive" | "signer";

export type WaiverEmailLegsState = {
  emailStatus: WaiverEmailStatus;
  emailError: string | null;
  signerEmailStatus: WaiverEmailStatus;
  signerEmailError: string | null;
};

// SKIPPED senza errore vuol dire che non c'era niente da mandare (una firma ospite non prevede
// copia al firmatario): non e' un guasto e reinviarla non produrrebbe nessuna mail. SKIPPED con
// errore vuol dire che l'invio non e' partito, e allora il reinvio ha senso.
function isRetriableLeg(status: WaiverEmailStatus, error: string | null) {
  return status === "FAILED" || (status === "SKIPPED" && error !== null);
}

// Le leg che un reinvio deve coprire: quella gia' riuscita resta fuori, altrimenti il reinvio
// duplica la mail arrivata invece di recuperare quella persa.
export function retriableWaiverEmailLegs(signature: WaiverEmailLegsState): WaiverMailLeg[] {
  const legs: WaiverMailLeg[] = [];

  if (isRetriableLeg(signature.emailStatus, signature.emailError)) {
    legs.push("archive");
  }

  if (isRetriableLeg(signature.signerEmailStatus, signature.signerEmailError)) {
    legs.push("signer");
  }

  return legs;
}

// Le colonne della leg "signer" hanno due proprietari. Quando la partita e' ancora in attesa
// firme, la mail che il referente riceve e' l'avviso: si porta il PDF allegato e assorbe l'esito
// della copia, cosi' al referente arriva una mail sola. Appena la partita e' confermata o
// annullata l'avviso non ha piu' senso e la copia torna a essere il PDF nudo.
//
// Il reinvio deve mandare quello che la colonna deve davvero: rimandare il PDF nudo dove mancava
// l'avviso riporta la colonna a SENT e fa sparire il bottone, ma il link firma ospiti - l'unica
// via per far firmare gli altri giocatori - non e' mai arrivato. L'admin vede verde e la partita
// si auto-annulla lo stesso.
export function signerLegCarriesPendingNotice(signature: {
  signerRole: WaiverSignerRole;
  booking: { status: BookingStatus };
}) {
  return signature.signerRole === "ORGANIZER" && signature.booking.status === "PENDING_SIGNATURES";
}
