// Motivo di annullamento facoltativo, condiviso da prod, demo store e UI cosi' la causale segue
// le stesse regole ovunque: nessuna duplicazione, un solo posto da toccare. Il flusso senza motivo
// resta identico, la causale e' sempre facoltativa e viene semplicemente ignorata se vuota.

// Causali predefinite offerte dalla piccola select. Accenti veri nelle stringhe utente. Chi sceglie
// "Altro" scrive un testo libero breve al posto di una di queste: il valore salvato e' comunque una
// stringa, quindi il server non deve distinguere preset e testo libero, gli basta normalizzare.
export const cancelReasonPresets = [
  "Imprevisto",
  "Maltempo",
  "Non servono più il campo",
] as const;

// Etichetta della voce "Altro" nella select: sceglierla apre il campo di testo libero.
export const cancelReasonOtherLabel = "Altro";

export const maxCancelReasonLength = 200;

// Normalizza la causale: taglia gli spazi, comprime gli spazi interni, tronca a 200 e riduce a null
// quando resta vuota. Un motivo assente e uno vuoto sono la stessa cosa: nessuna causale registrata.
export function normalizeCancelReason(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const collapsed = value.trim().replace(/\s+/g, " ");
  if (!collapsed) return null;
  return collapsed.slice(0, maxCancelReasonLength);
}

// Stato della piccola select lato UI: "" nessun motivo, un preset, oppure "OTHER" col testo libero.
export type CancelReasonMode = "" | (typeof cancelReasonPresets)[number] | "OTHER";

// Risolve la scelta della select nella stringa da inviare: preset o testo libero, "" se nessuno.
export function resolveCancelReason(mode: CancelReasonMode, otherText: string): string {
  if (mode === "OTHER") return otherText.trim();
  return mode;
}
