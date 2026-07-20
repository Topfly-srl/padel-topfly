#!/usr/bin/env node
// Anteprima delle email: rende in un unico file HTML tutti i messaggi che src/lib/graph.ts
// manderebbe a Microsoft Graph, con dati finti ma realistici. Non invia niente.
//
// I payload sono funzioni private del modulo e restano tali: lo script sostituisce la fetch
// globale con uno stub e chiama le funzioni send* pubbliche, intercettando il corpo della
// richiesta che sarebbe partita. Cosi' l'anteprima passa dal percorso vero (oggetto, allegati,
// destinatari inclusi) invece che da una copia dei template destinata a divergere.
//
// Uso:
//   npm run preview:emails
//   npm run preview:emails -- --out /percorso/anteprima.html

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const defaultOutFile = path.join(projectRoot, "output", "anteprima-email.html");

// Le stesse variabili che config.ts pretende per considerare Graph configurato: senza, ogni
// send* torna SKIPPED e l'anteprima uscirebbe vuota. Sono segnaposto, non escono da qui.
function stubGraphEnv() {
  process.env.APP_ENV = "development";
  process.env.APP_TIME_ZONE = "Europe/Rome";
  process.env.MS_GRAPH_TENANT_ID = "preview-tenant";
  process.env.MS_GRAPH_CLIENT_ID = "preview-client";
  process.env.MS_GRAPH_CLIENT_SECRET = "preview-secret";
  process.env.MS_GRAPH_MAILBOX = "padel@topflysolutions.com";
  process.env.APP_WAIVER_RECIPIENT_EMAIL = "padel@topflysolutions.com";
}

// Nessuna chiamata esce davvero: lo stub risponde al posto di Graph e tiene da parte i corpi.
function stubGraphFetch() {
  const requests = [];

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);

    if (url.includes("login.microsoftonline.com")) {
      return Response.json({ access_token: "preview-token", expires_in: 3600 });
    }

    requests.push({ url, method: init.method ?? "GET", body: String(init.body ?? "") });

    // createOutlookEvent legge l'id dalla risposta: va restituito JSON o l'anteprima si ferma qui.
    return Response.json({ id: "preview-event-id" }, { status: 201 });
  };

  return requests;
}

async function importGraph() {
  const { runnerImport } = await import("vite");
  const { module } = await runnerImport(path.join(projectRoot, "src/lib/graph.ts"), {
    root: projectRoot,
    configFile: false,
    resolve: { alias: { "@": path.join(projectRoot, "src") } },
    logLevel: "silent",
  });

  return module;
}

const organizer = {
  name: "Giulia Ferrari",
  email: "giulia.ferrari@topflysolutions.com",
};

// Dati finti ma plausibili: nomi con apostrofo e accento, orari veri di Roma, link nella forma
// che costruiscono booking-service e waiver-service.
const bookingId = "cly8k2f9x0001qz7h3n1r4v2c";
const signatureId = "cly8k2f9x0007qz7h9m4t1b8d";
const baseUrl = "https://padel.topflysolutions.com";
const manageUrl = `${baseUrl}/manage/${bookingId}?token=4f1c7a9e2b6d5083`;
const guestWaiverUrl = `${baseUrl}/waiver/${bookingId}?token=9d3b8e5c1a704f26`;
const cancelUrl = `${baseUrl}/waiver/cancel/${signatureId}?token=7c2a4f6b9e130d85`;
const signedAt = new Date("2026-07-19T09:12:00.000Z");
const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const filename = "scarico-responsabilita-giulia-ferrari.pdf";

const guest = {
  name: "Sofia D'Amico",
  email: "sofia.damico@topflysolutions.com",
};

function bookingFixture(overrides = {}) {
  return {
    id: bookingId,
    start: new Date("2026-07-21T16:30:00.000Z"),
    end: new Date("2026-07-21T18:00:00.000Z"),
    status: "PENDING_SIGNATURES",
    organizerName: organizer.name,
    organizerEmail: organizer.email,
    manageTokenHash: null,
    manageTokenExpiresAt: null,
    outlookEventId: null,
    outlookSyncStatus: "PENDING",
    outlookSyncError: null,
    playerCount: 4,
    waiverRevision: 1,
    signatureDeadlineAt: new Date("2026-07-21T14:30:00.000Z"),
    signatureWindowStartedAt: new Date("2026-07-19T09:00:00.000Z"),
    signatureReminderSentAt: null,
    signatureConfirmedAt: null,
    autoCanceledAt: null,
    guestWaiverTokenHash: null,
    guestWaiverTokenExpiresAt: null,
    createdAt: new Date("2026-07-19T09:00:00.000Z"),
    updatedAt: new Date("2026-07-19T09:00:00.000Z"),
    organizerId: null,
    ...overrides,
  };
}

const pendingBooking = bookingFixture();
const confirmedBooking = bookingFixture({
  status: "CONFIRMED",
  signatureConfirmedAt: new Date("2026-07-19T10:05:00.000Z"),
});
const canceledBooking = bookingFixture({ status: "CANCELED" });
const previousBooking = bookingFixture({
  start: new Date("2026-07-20T17:00:00.000Z"),
  end: new Date("2026-07-20T18:30:00.000Z"),
});

const waiverInput = {
  booking: confirmedBooking,
  signerName: organizer.name,
  signerEmail: organizer.email,
  signedAt,
  pdfBytes,
  filename,
};

// Un caso per ogni funzione pubblica che produce HTML. deleteOutlookEvent resta fuori: manda un
// commento testuale a event/cancel, e oggetto e struttura di quella mail li fa Outlook.
const cases = [
  {
    name: "createOutlookEvent",
    note: "Invito Outlook al referente quando la sua firma basta a confermare: col link gestione.",
    run: (graph) => graph.createOutlookEvent(confirmedBooking, organizer, manageUrl),
  },
  {
    // L'altro percorso di conferma: l'ultima firma ospite. Li' il token di gestione e' salvato
    // solo come hash, quindi l'invito non puo' portare bottoni e il footer rimanda all'app.
    name: "createOutlookEvent (senza link gestione)",
    note: "Invito Outlook quando a confermare e' l'ultima firma ospite: il token in chiaro non c'e'.",
    run: (graph) => graph.createOutlookEvent(confirmedBooking, organizer),
  },
  {
    name: "sendWaiverEmail",
    note: "Due leg dello stesso PDF: copia all'archivio e copia al firmatario.",
    run: (graph) => graph.sendWaiverEmail({ ...waiverInput, signerCopyEmail: organizer.email }),
  },
  {
    name: "sendGuestWaiverConfirmationEmail",
    note: "Ricevuta all'ospite che ha appena firmato, con PDF e ICS.",
    run: (graph) =>
      graph.sendGuestWaiverConfirmationEmail({
        booking: confirmedBooking,
        signerName: guest.name,
        signerEmail: guest.email,
        signedAt,
        cancelUrl,
        pdfBytes,
        filename: "scarico-responsabilita-sofia-damico.pdf",
      }),
  },
  {
    name: "sendGuestBookingUpdatedEmail",
    note: "Partita spostata: l'ospite deve rifirmare per il nuovo orario.",
    run: (graph) =>
      graph.sendGuestBookingUpdatedEmail({
        previousBooking,
        booking: pendingBooking,
        signerName: guest.name,
        signerEmail: guest.email,
        guestWaiverUrl,
      }),
  },
  {
    name: "sendGuestBookingCanceledEmail",
    note: "Partita annullata: avviso all'ospite con ICS di cancellazione.",
    run: (graph) =>
      graph.sendGuestBookingCanceledEmail({
        booking: canceledBooking,
        signerName: guest.name,
        signerEmail: guest.email,
      }),
  },
  {
    name: "sendGuestWithdrawalConfirmationEmail",
    note: "L'ospite ha rinunciato al posto: ricevuta e ritiro dell'appuntamento.",
    run: (graph) =>
      graph.sendGuestWithdrawalConfirmationEmail({
        booking: pendingBooking,
        signerName: guest.name,
        signerEmail: guest.email,
      }),
  },
  {
    name: "sendOrganizerPendingSignatureEmail",
    note: "Prenotazione presa in carico, in attesa delle firme mancanti.",
    run: (graph) =>
      graph.sendOrganizerPendingSignatureEmail({
        booking: pendingBooking,
        signedCount: 1,
        manageUrl,
        guestWaiverUrl,
        pdfBytes,
        filename,
      }),
  },
  {
    name: "sendOrganizerGuestWithdrewEmail",
    note: "Un ospite si e' sfilato: al referente serve un sostituto.",
    run: (graph) =>
      graph.sendOrganizerGuestWithdrewEmail({
        booking: pendingBooking,
        signerName: guest.name,
        signedCount: 2,
        guestWaiverUrl,
      }),
  },
  {
    name: "sendOrganizerSignatureReminderEmail",
    note: "Promemoria prima della scadenza firme.",
    run: (graph) =>
      graph.sendOrganizerSignatureReminderEmail({ booking: pendingBooking, signedCount: 3 }),
  },
  {
    name: "sendOrganizerAutoCanceledEmail",
    note: "Annullamento automatico del cron per firme mancanti.",
    run: (graph) =>
      graph.sendOrganizerAutoCanceledEmail({ booking: canceledBooking, signedCount: 2 }),
  },
  {
    name: "sendOrganizerBookingCanceledEmail (organizer)",
    note: "Ricevuta al referente che ha annullato da solo.",
    run: (graph) =>
      graph.sendOrganizerBookingCanceledEmail({ booking: canceledBooking, actor: "organizer" }),
  },
  {
    name: "sendOrganizerBookingCanceledEmail (admin)",
    note: "Stessa mail quando ad annullare e' l'amministrazione.",
    run: (graph) =>
      graph.sendOrganizerBookingCanceledEmail({ booking: canceledBooking, actor: "admin" }),
  },
];

// sendMail annida il messaggio sotto "message"; il payload dell'evento di calendario e' gia' il
// messaggio, e al posto di toRecipients porta gli attendees.
function readMessage(request) {
  const payload = JSON.parse(request.body);
  const message = payload.message ?? payload;
  const recipients = message.toRecipients ?? message.attendees ?? [];

  return {
    subject: message.subject ?? "",
    recipients: recipients.map((recipient) => formatRecipient(recipient.emailAddress)),
    attachments: (message.attachments ?? []).map((attachment) => attachment.name),
    content: message.body?.content ?? "",
  };
}

function formatRecipient(emailAddress = {}) {
  return emailAddress.name ? `${emailAddress.name} <${emailAddress.address}>` : emailAddress.address;
}

// Il preheader e' l'unico blocco nascosto dello shell: e' quello che il client mostra in lista
// accanto all'oggetto, quindi va letto qui e riportato in chiaro nell'intestazione.
function readPreheader(content) {
  const match = content.match(/<div style="[^"]*mso-hide: all[^"]*">([\s\S]*?)<\/div>/);
  return match ? decodeEntities(match[1]).trim() : "";
}

function decodeEntities(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function collectMails(graph, requests) {
  const mails = [];

  for (const testCase of cases) {
    requests.length = 0;
    await testCase.run(graph);
    const captured = requests.splice(0);

    if (captured.length === 0) {
      throw new Error(`${testCase.name}: nessuna chiamata intercettata.`);
    }

    for (const request of captured) {
      const message = readMessage(request);
      mails.push({
        name: captured.length > 1 ? `${testCase.name} [${message.recipients[0]}]` : testCase.name,
        note: testCase.note,
        ...message,
        preheader: readPreheader(message.content),
      });
    }
  }

  return mails;
}

function metaRow(label, value) {
  return `
        <div class="row">
          <div class="label">${escapeHtml(label)}</div>
          <div class="value">${value ? escapeHtml(value) : '<span class="empty">assente</span>'}</div>
        </div>`;
}

function renderMail(mail, index) {
  const anchor = `mail-${index + 1}`;

  return `
    <section class="card" id="${anchor}">
      <header class="meta">
        <div class="tech"><a href="#${anchor}">${escapeHtml(mail.name)}</a></div>
        ${mail.note ? `<p class="note">${escapeHtml(mail.note)}</p>` : ""}
        ${metaRow("Oggetto", mail.subject)}
        ${metaRow("Destinatario", mail.recipients.join(", "))}
        ${metaRow("Preheader", mail.preheader)}
        ${mail.attachments.length > 0 ? metaRow("Allegati", mail.attachments.join(", ")) : ""}
      </header>
      <div class="stage">
        <div class="client">${mail.content}</div>
      </div>
    </section>`;
}

function renderPage(mails) {
  const index = mails
    .map((mail, position) => `<li><a href="#mail-${position + 1}">${escapeHtml(mail.name)}</a></li>`)
    .join("\n        ");

  return `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Anteprima email - Padel TOPFLY</title>
<style>
  :root { color-scheme: light; }
  body {
    margin: 0;
    background: #f7f7f8;
    color: #202124;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
    font-size: 15px;
    line-height: 1.45;
  }
  .page { max-width: 720px; margin: 0 auto; padding: 32px 16px 72px; }
  h1 { font-size: 24px; margin: 0 0 6px; }
  .intro { margin: 0 0 24px; color: #6d7077; font-size: 14px; }
  .toc { background: #ffffff; border: 1px solid #e2e4e8; padding: 16px 20px; margin: 0 0 28px; }
  .toc h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; margin: 0 0 10px; }
  .toc ol { margin: 0; padding-left: 20px; font-size: 14px; }
  .toc li { margin: 3px 0; }
  a { color: #c81317; }
  .card { background: #ffffff; border: 1px solid #e2e4e8; margin: 0 0 28px; }
  .meta { padding: 16px 20px; border-bottom: 1px solid #e2e4e8; }
  .tech { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 14px; font-weight: 700; }
  .tech a { text-decoration: none; }
  .note { margin: 4px 0 12px; color: #6d7077; font-size: 13px; }
  .row { display: flex; gap: 12px; padding: 4px 0; font-size: 13px; }
  .label { flex: 0 0 92px; color: #6d7077; }
  .value { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .empty { color: #b4232a; font-style: italic; }
  .stage { background: #d8dade; padding: 24px 12px; }
  .client { width: 560px; max-width: 100%; margin: 0 auto; }
</style>
</head>
<body>
  <div class="page">
    <h1>Anteprima email - Padel TOPFLY</h1>
    <p class="intro">
      ${mails.length} messaggi resi con dati finti dai payload veri di <code>src/lib/graph.ts</code>.
      Nessun invio: le chiamate a Microsoft Graph sono intercettate. Ogni mail e' mostrata in un
      contenitore da 560px come la vedrebbe un client.
    </p>
    <nav class="toc">
      <h2>Indice</h2>
      <ol>
        ${index}
      </ol>
    </nav>
    ${mails.map(renderMail).join("\n")}
  </div>
</body>
</html>
`;
}

function readOutFile(argv) {
  const flag = argv.indexOf("--out");
  if (flag !== -1 && argv[flag + 1]) return path.resolve(argv[flag + 1]);

  const inline = argv.find((arg) => arg.startsWith("--out="));
  if (inline) return path.resolve(inline.slice("--out=".length));

  return defaultOutFile;
}

async function main() {
  const outFile = readOutFile(process.argv.slice(2));

  stubGraphEnv();
  const requests = stubGraphFetch();
  const graph = await importGraph();
  const mails = await collectMails(graph, requests);

  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, renderPage(mails), "utf8");

  console.log(`Anteprima di ${mails.length} email scritta in ${outFile}`);
}

await main();
