import { describe, expect, it } from "vitest";
import {
  signatureDeadlineAt,
  signatureReminderDueAt,
  signatureReplacementDeadlineAt,
} from "@/lib/signature-workflow";

const createdAt = new Date("2026-07-14T09:00:00.000Z");

describe("signatureDeadlineAt", () => {
  it("lascia 24 ore alle prenotazioni ravvicinate", () => {
    // Start tra 32 ore: meta' del tempo mancante sarebbe 14h, vince il minimo di 24h.
    const deadline = signatureDeadlineAt(new Date("2026-07-15T17:00:00.000Z"), createdAt);

    expect(deadline.toISOString()).toBe("2026-07-15T09:00:00.000Z");
  });

  it("scala la finestra a meta' del preavviso per le prenotazioni lontane", () => {
    // Start tra 5 giorni: restano 116h al cutoff, meta' fa 58h -> ne' il minimo ne' il tetto
    // mordono, comanda la proporzione.
    const deadline = signatureDeadlineAt(new Date("2026-07-19T09:00:00.000Z"), createdAt);

    expect(deadline.toISOString()).toBe("2026-07-16T19:00:00.000Z");
  });

  it("non tiene lo slot bloccato oltre 4 giorni", () => {
    // Start tra 10 giorni: meta' del preavviso farebbe 122h, ma il tetto la ferma a 96h.
    const deadline = signatureDeadlineAt(new Date("2026-07-24T17:00:00.000Z"), createdAt);

    expect(deadline.toISOString()).toBe("2026-07-18T09:00:00.000Z");
  });

  it("applica il tetto anche all'anticipo massimo di 14 giorni", () => {
    const deadline = signatureDeadlineAt(new Date("2026-07-28T09:00:00.000Z"), createdAt);
    const giorni = (deadline.getTime() - createdAt.getTime()) / 86_400_000;

    expect(giorni).toBe(4);
  });

  it("garantisce 30 minuti anche appena sopra il cutoff delle 4 ore", () => {
    // Start tra 4h01m: senza pavimento la deadline finiva schiacciata sul cutoff, lasciando
    // 1 minuto per raccogliere le firme contro i 30 di chi prenota due minuti dopo.
    const start = new Date(createdAt.getTime() + (4 * 60 + 1) * 60_000);
    const deadline = signatureDeadlineAt(start, createdAt);

    expect((deadline.getTime() - createdAt.getTime()) / 60_000).toBe(30);
  });

  it("muoversi prima non da' mai meno tempo per firmare", () => {
    // Monotonia: il tempo utile non deve mai calare al crescere dell'anticipo, altrimenti
    // aspettare a prenotare diventa la mossa furba.
    const minuti = [5, 15, 30, 60, 120, 239, 240, 241, 250, 270, 300, 360, 600, 1680, 3120, 14400];
    let precedente = 0;

    for (const m of minuti) {
      const start = new Date(createdAt.getTime() + m * 60_000);
      const utile = (signatureDeadlineAt(start, createdAt).getTime() - createdAt.getTime()) / 60_000;

      expect(utile).toBeGreaterThanOrEqual(precedente);
      precedente = utile;
    }
  });

  it("non supera mai il cutoff di 4 ore prima dell'inizio", () => {
    // Start tra 11 ore: createdAt + 24h sforerebbe l'inizio, vince il cutoff.
    const deadline = signatureDeadlineAt(new Date("2026-07-14T20:00:00.000Z"), createdAt);

    expect(deadline.toISOString()).toBe("2026-07-14T16:00:00.000Z");
  });

  it("da' 30 minuti alle prenotazioni sotto le 4 ore dall'inizio", () => {
    const deadline = signatureDeadlineAt(new Date("2026-07-14T11:00:00.000Z"), createdAt);

    expect(deadline.toISOString()).toBe("2026-07-14T09:30:00.000Z");
  });

  it("non manda la scadenza oltre l'inizio per le prenotazioni immediate", () => {
    const deadline = signatureDeadlineAt(new Date("2026-07-14T09:15:00.000Z"), createdAt);

    expect(deadline.toISOString()).toBe("2026-07-14T09:15:00.000Z");
  });

  it("non manda il reminder appena creata una prenotazione con finestra corta", () => {
    // Prenoti alle 9:00 per le 17:00: la finestra firme e' 9:00-13:00. Con lead fisso a 6h il
    // reminder sarebbe partito subito (13:00 dista meno di 6h), sprecando l'unica sveglia.
    const start = new Date("2026-07-14T17:00:00.000Z");
    const deadline = signatureDeadlineAt(start, createdAt);
    const due = signatureReminderDueAt({ createdAt, signatureDeadlineAt: deadline });

    expect(deadline.toISOString()).toBe("2026-07-14T13:00:00.000Z");
    expect(due!.toISOString()).toBe("2026-07-14T11:00:00.000Z"); // meta' finestra, non 9:00
    expect(due! > createdAt).toBe(true);
  });

  it("tiene il reminder a 6 ore per le finestre lunghe", () => {
    // Finestra di 5 giorni: meta' sarebbe 2 giorni e mezzo, quindi vince il tetto di 6 ore.
    const deadline = signatureDeadlineAt(new Date("2026-07-24T17:00:00.000Z"), createdAt);
    const due = signatureReminderDueAt({ createdAt, signatureDeadlineAt: deadline });

    expect((deadline.getTime() - due!.getTime()) / 3_600_000).toBe(6);
  });

  it("stringe il reminder anche sulle finestre last minute", () => {
    // 30 minuti di finestra: il reminder cade a meta', non subito e non dopo la scadenza.
    const deadline = signatureDeadlineAt(new Date("2026-07-14T11:00:00.000Z"), createdAt);
    const due = signatureReminderDueAt({ createdAt, signatureDeadlineAt: deadline });

    expect(due!.toISOString()).toBe("2026-07-14T09:15:00.000Z");
  });

  it("non produce mai un reminder fuori dalla finestra", () => {
    for (const ore of [0.25, 2, 5, 9, 12, 28, 48, 240]) {
      const start = new Date(createdAt.getTime() + ore * 3_600_000);
      const deadline = signatureDeadlineAt(start, createdAt);
      const due = signatureReminderDueAt({ createdAt, signatureDeadlineAt: deadline });

      expect(due!.getTime()).toBeGreaterThanOrEqual(createdAt.getTime());
      expect(due!.getTime()).toBeLessThanOrEqual(deadline.getTime());
    }
  });

  it("dopo una rinuncia riparte la finestra dall'inizio nuovo, non da createdAt", () => {
    // Prenotazione nata 5 giorni fa, rinuncia adesso con nuova deadline fra 2 ore. Se la finestra
    // partisse ancora da createdAt il sollecito risulterebbe gia' dovuto (deadline-6h e' nel
    // passato) e il referente riceverebbe avviso rinuncia e sollecito nello stesso istante.
    const bornAt = new Date(createdAt.getTime() - 5 * 24 * 3_600_000);
    const now = createdAt;
    const deadline = new Date(now.getTime() + 2 * 3_600_000);

    const stale = signatureReminderDueAt({ createdAt: bornAt, signatureDeadlineAt: deadline });
    expect(stale! <= now).toBe(true); // senza il nuovo inizio il sollecito e' gia' scaduto

    const due = signatureReminderDueAt({
      createdAt: bornAt,
      signatureWindowStartedAt: now,
      signatureDeadlineAt: deadline,
    });

    // Finestra di 2 ore: meta' fa 1 ora, sotto il tetto di 6 -> sollecito a deadline-1h, non dovuto.
    expect(due!.toISOString()).toBe(new Date(now.getTime() + 1 * 3_600_000).toISOString());
    expect(due! > now).toBe(true);
  });

  it("da' 2 ore per sostituire chi rinuncia a ridosso, non 30 minuti", () => {
    // Ospite che si sfila alle 18:00 da una partita confermata delle 20:00: la regola normale
    // lo tratterebbe come una prenotazione last minute e lascerebbe mezz'ora.
    const now = new Date("2026-07-14T18:00:00.000Z");
    const start = new Date("2026-07-14T20:00:00.000Z");

    expect(signatureDeadlineAt(start, now).toISOString()).toBe("2026-07-14T18:30:00.000Z");
    expect(signatureReplacementDeadlineAt(start, now).toISOString()).toBe("2026-07-14T20:00:00.000Z");
  });

  it("non manda la finestra di sostituzione oltre l'inizio della partita", () => {
    const now = new Date("2026-07-14T19:30:00.000Z");
    const start = new Date("2026-07-14T20:00:00.000Z");

    expect(signatureReplacementDeadlineAt(start, now).toISOString()).toBe("2026-07-14T20:00:00.000Z");
  });

  it("per una rinuncia lontana tiene la finestra normale, piu' generosa delle 2 ore", () => {
    // Rinuncia 3 giorni prima: la regola normale da' gia' molto piu' di 2 ore, non va ristretta.
    const start = new Date(createdAt.getTime() + 3 * 24 * 3_600_000);
    const normale = signatureDeadlineAt(start, createdAt);
    const sostituzione = signatureReplacementDeadlineAt(start, createdAt);

    expect(sostituzione.toISOString()).toBe(normale.toISOString());
    expect(sostituzione.getTime() - createdAt.getTime()).toBeGreaterThan(2 * 3_600_000);
  });

  it("libera sempre lo slot con almeno meta' del preavviso residuo", () => {
    for (const days of [2, 5, 10, 14]) {
      const start = new Date(createdAt.getTime() + days * 24 * 60 * 60_000);
      const deadline = signatureDeadlineAt(start, createdAt);
      const elapsed = deadline.getTime() - createdAt.getTime();
      const total = start.getTime() - createdAt.getTime();

      expect(elapsed).toBeLessThanOrEqual(total / 2);
    }
  });
});
