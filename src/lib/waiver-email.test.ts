import { describe, expect, it } from "vitest";
import { retriableWaiverEmailLegs, signerLegCarriesPendingNotice } from "@/lib/waiver-email";

function legsState(overrides: Partial<Parameters<typeof retriableWaiverEmailLegs>[0]> = {}) {
  return {
    emailStatus: "SENT" as const,
    emailError: null,
    signerEmailStatus: "SENT" as const,
    signerEmailError: null,
    ...overrides,
  };
}

describe("leg da reinviare dello scarico", () => {
  it("non ripete la copia all'archivio quando manca solo quella al referente", () => {
    const legs = retriableWaiverEmailLegs(
      legsState({ signerEmailStatus: "FAILED", signerEmailError: "mailbox piena" }),
    );

    // Il bug che questo previene: il reinvio mandava un doppione all'archivio e lasciava il
    // referente senza niente.
    expect(legs).toEqual(["signer"]);
  });

  it("reinvia solo l'archivio quando la copia al referente e' partita", () => {
    const legs = retriableWaiverEmailLegs(
      legsState({ emailStatus: "FAILED", emailError: "Graph 500" }),
    );

    expect(legs).toEqual(["archive"]);
  });

  it("reinvia entrambe le copie quando nessuna delle due e' partita", () => {
    const legs = retriableWaiverEmailLegs(
      legsState({
        emailStatus: "SKIPPED",
        emailError: "Microsoft Graph non configurato.",
        signerEmailStatus: "SKIPPED",
        signerEmailError: "Microsoft Graph non configurato.",
      }),
    );

    expect(legs).toEqual(["archive", "signer"]);
  });

  it("non reinvia niente quando entrambe le copie sono arrivate", () => {
    expect(retriableWaiverEmailLegs(legsState())).toEqual([]);
  });

  it("non considera da reinviare la copia al firmatario che non era dovuta", () => {
    // Firma ospite (o referente che coincide con l'archivio): SKIPPED senza errore vuol dire
    // che non c'era nessuna mail da mandare, non che se ne e' persa una.
    const legs = retriableWaiverEmailLegs(
      legsState({ signerEmailStatus: "SKIPPED", signerEmailError: null }),
    );

    expect(legs).toEqual([]);
  });

  it("lascia in pace le leg ancora in coda", () => {
    const legs = retriableWaiverEmailLegs(
      legsState({ emailStatus: "PENDING", signerEmailStatus: "PENDING" }),
    );

    expect(legs).toEqual([]);
  });
});

describe("proprietario della leg copia al referente", () => {
  it("e' l'avviso finche' la partita aspetta le firme", () => {
    // Alla creazione di una partita multi-giocatore l'avviso si porta il PDF allegato e assorbe
    // l'esito della copia: e' quella la mail che la colonna registra, ed e' quella che il
    // reinvio deve rimandare.
    expect(
      signerLegCarriesPendingNotice({
        signerRole: "ORGANIZER",
        booking: { status: "PENDING_SIGNATURES" },
      }),
    ).toBe(true);
  });

  it("torna il PDF nudo quando la partita non aspetta piu' niente", () => {
    // Confermata o annullata, l'avviso attesa firme non ha piu' senso: la copia al referente
    // torna a essere quello che e' sempre stata, e il reinvio manda quella.
    for (const status of ["CONFIRMED", "CANCELED"] as const) {
      expect(
        signerLegCarriesPendingNotice({ signerRole: "ORGANIZER", booking: { status } }),
      ).toBe(false);
    }
  });

  it("non riguarda le firme ospite, che una copia al firmatario non ce l'hanno", () => {
    expect(
      signerLegCarriesPendingNotice({
        signerRole: "GUEST",
        booking: { status: "PENDING_SIGNATURES" },
      }),
    ).toBe(false);
  });
});
