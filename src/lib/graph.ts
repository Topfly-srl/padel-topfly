import type { Booking } from "@/generated/prisma/client";
import { appConfig, hasGraphConfig } from "@/lib/config";
import type { WaiverMailLeg } from "@/lib/waiver-email";

type GraphSyncResult =
  | { status: "SKIPPED"; eventId?: string; error?: string }
  | { status: "SYNCED"; eventId?: string; error?: string }
  | { status: "FAILED"; eventId?: string; error: string };

type WaiverMailResult =
  | { status: "SKIPPED"; error?: string }
  | { status: "SENT" }
  | { status: "FAILED"; error: string };

// Un esito per leg richiesta: due sendMail distinti, nessuno dei due puo' mascherare l'altro.
// La leg non richiesta e' assente, che e' diverso da "richiesta e saltata".
export type WaiverMailLegResults = Partial<Record<WaiverMailLeg, WaiverMailResult>>;

type GraphToken = {
  accessToken: string;
  expiresAt: number;
};

let cachedToken: GraphToken | null = null;

function graphDisabled(): GraphSyncResult | null {
  if (!hasGraphConfig()) {
    return {
      status: "SKIPPED",
      error: "Microsoft Graph non configurato.",
    };
  }

  return null;
}

async function getGraphToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }

  const body = new URLSearchParams({
    client_id: appConfig.graph.clientId!,
    client_secret: appConfig.graph.clientSecret!,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });

  const response = await fetch(
    `https://login.microsoftonline.com/${appConfig.graph.tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
  );

  if (!response.ok) {
    throw new Error(`Graph token error ${response.status}`);
  }

  const json = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };

  cachedToken = {
    accessToken: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };

  return cachedToken.accessToken;
}

async function graphFetch(path: string, init: RequestInit = {}) {
  const token = await getGraphToken();
  const response = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(graphErrorMessage(response, body));
  }

  return response;
}

function graphErrorMessage(response: Response, body: string) {
  let code = "";

  try {
    const parsed = JSON.parse(body) as { error?: { code?: string } };
    code = parsed.error?.code ? ` (${parsed.error.code})` : "";
  } catch {
    code = "";
  }

  return `Graph ${response.status}${code}`;
}

type OrganizerContact = {
  email: string;
  name: string;
};

export type BookingCancelActor = "organizer" | "admin";

// I colori arrivano dal brand dell'app (src/app/globals.css) e vivono solo qui: il rosso non va
// rincorso dentro dieci template. Di --brand #f31317 non c'e' voce: sulle email il rosso pieno
// finirebbe solo sotto del testo bianco, dove non regge il contrasto (vedi emailToneColor).
const emailTheme = {
  brand2: "#c81317",
  danger: "#b4232a",
  foreground: "#202124",
  muted: "#6d7077",
  line: "#e2e4e8",
  surface: "#ffffff",
  background: "#f7f7f8",
  onAccent: "#ffffff",
  neutral: "#202124",
} as const;

// Il motore Word di Outlook desktop non eredita il font: va ripetuto su ogni cella di testo.
const emailFont = "Arial, Helvetica, sans-serif";

type EmailTone = "brand" | "danger";

// Il tono "brand" tinge fasce e bottoni, cioe' fondi con del testo bianco sopra. Bianco su
// --brand #f31317 da' 4.27:1: passa per il titolo (22px bold, large text, soglia 3:1) ma non per
// il kicker (12px) ne' per l'etichetta del bottone (15px), che come testo normale chiedono 4.5:1.
// --brand-2 #c81317 e' del brand vero e da' 5.90:1: tutto in AA senza uscire dalla palette.
// Niente tono verde: le mail restano sulla gamma del brand, il rosso scuro distingue solo gli
// annullamenti.
const emailToneColor: Record<EmailTone, string> = {
  brand: emailTheme.brand2,
  danger: emailTheme.danger,
};

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

type SafeHtml = { readonly markup: string };

type HtmlValue = string | number | SafeHtml | null | undefined | false | HtmlValue[];

function isSafeHtml(value: unknown): value is SafeHtml {
  return (
    typeof value === "object" && value !== null && typeof (value as SafeHtml).markup === "string"
  );
}

function renderHtmlValue(value: HtmlValue): string {
  if (value === null || value === undefined || value === false) return "";
  if (Array.isArray(value)) return value.map(renderHtmlValue).join("");
  if (isSafeHtml(value)) return value.markup;
  return escapeHtml(String(value));
}

// Interpola escapando tutto quello che non e' markup gia' costruito qui dentro: i payload non
// devono piu' ricordarsi di chiamare escapeHtml su ogni nome, e gli oggetti delle mail restano
// testo piano perche' non passano di qui.
function html(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
  let markup = strings[0];

  for (let index = 0; index < values.length; index += 1) {
    markup += renderHtmlValue(values[index]) + strings[index + 1];
  }

  return { markup };
}

type EmailRow = { label: string; value: HtmlValue };

type EmailAction = {
  label: string;
  url: string;
  tone?: "accent" | "neutral";
  hint?: string;
};

type EmailShellInput = {
  preheader: string;
  kicker?: string;
  title: string;
  tone?: EmailTone;
  greeting?: string;
  body?: HtmlValue[];
  rows?: EmailRow[];
  notice?: HtmlValue;
  actions?: EmailAction[];
  footer?: HtmlValue;
};

function emailRowsTable(rows: EmailRow[]) {
  const cellStyle = `background: ${emailTheme.background}; color: ${emailTheme.foreground}; font-family: ${emailFont}; font-size: 14px; padding: 12px 16px; border-bottom: 1px solid ${emailTheme.line};`;

  return html`
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width: 100%; border-collapse: collapse; margin: 6px 0 0; border: 1px solid ${emailTheme.line};">
      ${rows.map(
        (row) => html`
      <tr>
        <td bgcolor="${emailTheme.background}" width="36%" style="${cellStyle} width: 36%; color: ${emailTheme.muted};">${row.label}</td>
        <td bgcolor="${emailTheme.background}" style="${cellStyle} font-weight: 700;">${row.value}</td>
      </tr>`,
      )}
    </table>`;
}

// Il bordo colorato a sinistra regge da solo: niente border-radius come unico segnale, cosi' il
// riquadro resta riconoscibile anche dove gli angoli tondi non esistono.
function emailNotice(notice: HtmlValue, accent: string) {
  return html`
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width: 100%; border-collapse: collapse; margin: 18px 0 0;">
      <tr>
        <td bgcolor="${emailTheme.background}" style="background: ${emailTheme.background}; color: ${emailTheme.foreground}; font-family: ${emailFont}; font-size: 14px; padding: 12px 14px; border-left: 4px solid ${accent}; border-top: 1px solid ${emailTheme.line}; border-right: 1px solid ${emailTheme.line}; border-bottom: 1px solid ${emailTheme.line};">${notice}</td>
      </tr>
    </table>`;
}

// Sotto ogni bottone resta il link in chiaro: dove il bottone non si disegna o non si clicca,
// l'indirizzo e' comunque leggibile e copiabile.
function emailActionBlock(action: EmailAction, accent: string) {
  const background = action.tone === "neutral" ? emailTheme.neutral : accent;

  return html`
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse: collapse; margin: 20px 0 0;">
      <tr>
        <td bgcolor="${background}" align="center" style="background: ${background}; border: 1px solid ${background}; padding: 13px 18px; font-family: ${emailFont};">
          <a href="${action.url}" style="color: ${emailTheme.onAccent}; font-family: ${emailFont}; font-size: 15px; font-weight: 700; text-decoration: none;">${action.label}</a>
        </td>
      </tr>
    </table>
    <div style="margin: 8px 0 0; font-family: ${emailFont}; font-size: 14px; color: ${emailTheme.muted}; word-break: break-all;">
      ${action.hint ?? "Link diretto"}: <a href="${action.url}" style="font-family: ${emailFont}; color: ${emailTheme.brand2};">${action.url}</a>
    </div>`;
}

// Da qui nasce ogni email del progetto. Vincoli che reggono l'HTML su Outlook desktop (motore
// Word): tabelle role=presentation, bgcolor accanto allo style perche' il background shorthand
// viene ignorato, width in attributo che concorda con lo style, colori di sfondo e testo sempre
// espliciti (i client che invertono i colori non devono produrre testo bianco su bianco).
// Nessuna immagine: il marchio si fa col colore della fascia e col testo. Le mail restano
// leggibili dove le immagini sono bloccate.
//
// La larghezza passa dalla ghost table mso: il motore Word ignora max-width e sul contenitore
// resterebbe in piedi solo width: 100%, cioe' la mail stirata per tutta la finestra. Dentro il
// blocco condizionale il contenitore fluido eredita 560px dal genitore, fuori se li prende da
// max-width. Attributo e style del contenitore dicono entrambi 100%: opposti (560 contro 100%)
// il CSS vincerebbe sull'attributo e la regola servirebbe a niente.
function emailShell(input: EmailShellInput) {
  const accent = emailToneColor[input.tone ?? "brand"];
  const kicker = input.kicker ?? "TOPFLY GPS Solutions";
  const paragraphStyle = `margin: 0 0 12px; font-family: ${emailFont}; font-size: 15px; line-height: 1.45; color: ${emailTheme.foreground};`;

  return html`
<div style="margin: 0; padding: 0; background: ${emailTheme.background};">
  <div style="display: none; max-height: 0; overflow: hidden; mso-hide: all; font-size: 1px; line-height: 1px; color: ${emailTheme.background};">${input.preheader}</div>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="${emailTheme.background}" style="width: 100%; background: ${emailTheme.background}; border-collapse: collapse;">
    <tr>
      <td align="left" bgcolor="${emailTheme.background}" style="background: ${emailTheme.background}; padding: 0; font-family: ${emailFont};">
        <!--[if mso]>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="width: 560px; border-collapse: collapse;">
          <tr>
            <td bgcolor="${emailTheme.background}" style="background: ${emailTheme.background}; padding: 0; font-family: ${emailFont};">
        <![endif]-->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width: 100%; max-width: 560px; border-collapse: collapse;">
          <tr>
            <td bgcolor="${accent}" style="background: ${accent}; color: ${emailTheme.onAccent}; padding: 18px 20px; font-family: ${emailFont};">
              <div style="font-family: ${emailFont}; font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: ${emailTheme.onAccent};">${kicker}</div>
              <div style="font-family: ${emailFont}; font-size: 22px; font-weight: 700; line-height: 1.25; margin-top: 6px; color: ${emailTheme.onAccent};">${input.title}</div>
            </td>
          </tr>
          <tr>
            <td bgcolor="${emailTheme.surface}" style="background: ${emailTheme.surface}; color: ${emailTheme.foreground}; border: 1px solid ${emailTheme.line}; border-top: 0; padding: 20px; font-family: ${emailFont}; font-size: 15px; line-height: 1.45;">
              ${input.greeting ? html`<div style="${paragraphStyle} margin-bottom: 4px;">${input.greeting}</div>` : ""}
              ${(input.body ?? []).map((paragraph) => html`<div style="${paragraphStyle}">${paragraph}</div>`)}
              ${input.rows && input.rows.length > 0 ? emailRowsTable(input.rows) : ""}
              ${input.notice ? emailNotice(input.notice, accent) : ""}
              ${(input.actions ?? []).map((action) => emailActionBlock(action, accent))}
              ${input.footer ? html`<div style="margin: 18px 0 0; font-family: ${emailFont}; font-size: 14px; line-height: 1.45; color: ${emailTheme.muted};">${input.footer}</div>` : ""}
            </td>
          </tr>
        </table>
        <!--[if mso]>
            </td>
          </tr>
        </table>
        <![endif]-->
      </td>
    </tr>
  </table>
</div>`.markup;
}

function formatEventDate(date: Date) {
  return new Intl.DateTimeFormat("it-IT", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    timeZone: appConfig.timeZone,
  }).format(date);
}

function formatEventTime(date: Date) {
  return new Intl.DateTimeFormat("it-IT", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: appConfig.timeZone,
  }).format(date);
}

function formatDuration(start: Date, end: Date) {
  return Math.round((end.getTime() - start.getTime()) / 60_000);
}

function formatEventDateTime(date: Date) {
  return new Intl.DateTimeFormat("it-IT", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: appConfig.timeZone,
  }).format(date);
}

function formatEventSlot(booking: Booking) {
  return `${formatEventDate(booking.start)} · ${formatEventTime(booking.start)} - ${formatEventTime(booking.end)}`;
}

// L'oggetto e' testo piano: niente escapeHtml qui dentro, altrimenti "Anna & Marco" arriva
// scritto "Anna &amp; Marco" nella lista messaggi. La data dice di quale partita si parla, che
// e' l'unico modo di distinguere due mail identiche a colpo d'occhio.
function mailSubject(base: string, booking: Booking) {
  return `Padel TOPFLY - ${base} - ${formatEventDateTime(booking.start)}`;
}

// Un solo nome per il documento in tutte le mail: chi lo cerca in casella deve trovarlo.
const waiverDocumentName = "scarico di responsabilità";
const waiverDocumentTitle = "Scarico di responsabilità";

// L'unico oggetto senza la data della partita, ed e' voluto: non e' una mail ma il titolo di un
// evento di calendario, che nella griglia dell'agenda sta gia' sul suo giorno e alla sua ora.
// Ripetere "- mar 21 lug, 18:30" dentro il titolo sarebbe rumore su ogni riga dell'agenda.
const confirmedEventSubject = "Padel TOPFLY - Campo prenotato";

// L'oggetto vero della mail che porta i link firma: i rimandi devono mandare la gente a cercare
// una mail che esiste con questo nome, non "la prenotazione provvisoria".
const pendingSignatureSubjectBase = "Prenotazione in attesa firme";

const pendingSignatureMailReference = html`Usa il link firma ospiti che trovi nella mail "Padel TOPFLY - ${pendingSignatureSubjectBase}".`;

const autoCancelWarning =
  "Se manca anche una sola firma alla scadenza, la prenotazione viene annullata automaticamente.";

function signatureProgressCopy(input: { signedCount: number; playerCount: number }) {
  const missing = Math.max(0, input.playerCount - input.signedCount);
  const collected = `${input.signedCount} di ${input.playerCount}`;

  return {
    missingLabel: missing === 1 ? "Manca 1 firma" : `Mancano ${missing} firme`,
    collected,
    // Valore della riga "Firme", che il nome della riga lo da' gia': "1 di 4 raccolte, mancano 3".
    // Il conteggio e la mancanza detti una volta sola, e mai "mancano 3 su 4", che si legge al
    // contrario come se le firme fatte fossero tre.
    summary:
      missing === 0
        ? `${collected} raccolte`
        : `${collected} raccolte, ${missing === 1 ? "manca 1" : `mancano ${missing}`}`,
  };
}

function signatureDeadlineLabel(booking: Booking) {
  return booking.signatureDeadlineAt
    ? formatEventDateTime(booking.signatureDeadlineAt)
    : "la scadenza indicata nell'app";
}

// L'evento nasce solo a prenotazione CONFERMATA, cioe' quando le firme sono gia' tutte raccolte:
// un link firma ospiti qui dentro non ha nessuno da mandare a firmare.
function eventPayload(booking: Booking, organizer: OrganizerContact, manageUrl?: string) {
  const actions: EmailAction[] = [];

  if (manageUrl) {
    actions.push({ label: "Gestisci prenotazione", url: manageUrl });
  }

  return {
    subject: confirmedEventSubject,
    body: {
      contentType: "HTML",
      content: emailShell({
        preheader: `Campo confermato: ${formatEventSlot(booking)}.`,
        tone: "brand",
        title: "Prenotazione campo confermata",
        greeting: `Ciao ${organizer.name},`,
        body: ["la tua prenotazione del campo da padel aziendale è confermata."],
        rows: [
          { label: "Giorno", value: formatEventDate(booking.start) },
          {
            label: "Orario",
            value: `${formatEventTime(booking.start)} - ${formatEventTime(booking.end)}`,
          },
          { label: "Durata", value: `${formatDuration(booking.start, booking.end)} min` },
        ],
        notice: "Ti arriverà un promemoria Outlook 1 ora prima.",
        actions,
        // Senza manageUrl non c'e' nessuna mail a cui rimandare: il percorso di conferma non
        // passa il link (signature-workflow non ha il token in chiaro) e con un giocatore solo
        // l'avviso di attesa firme non parte mai. Mandare a cercare "la mail Campo prenotato" e'
        // un cerchio: quella mail e' questa, e il link non ce l'ha. L'app invece ce l'ha sempre.
        footer: manageUrl
          ? "Se cambi programma, modifica o annulla la prenotazione: così lasci libero il campo per gli altri."
          : "Per modifiche o annullamenti apri la tua prenotazione nell'app Padel TOPFLY: così lasci libero il campo per gli altri.",
      }),
    },
    start: {
      dateTime: booking.start.toISOString(),
      timeZone: "UTC",
    },
    end: {
      dateTime: booking.end.toISOString(),
      timeZone: "UTC",
    },
    attendees: [
      {
        emailAddress: {
          address: organizer.email,
          name: organizer.name,
        },
        type: "required",
      },
    ],
    isReminderOn: true,
    reminderMinutesBeforeStart: 60,
    showAs: "busy",
  };
}

function waiverMailPayload(input: {
  recipientEmail: string;
  booking: Booking;
  signerName: string;
  signerEmail: string;
  signedAt: Date;
  pdfBytes: Uint8Array;
  filename: string;
}) {
  return {
    message: {
      subject: mailSubject(`${waiverDocumentTitle} - ${input.signerName}`, input.booking),
      body: {
        contentType: "HTML",
        content: emailShell({
          preheader: `${waiverDocumentTitle} firmato da ${input.signerName} per la partita del ${formatEventDateTime(input.booking.start)}.`,
          title: waiverDocumentTitle,
          body: [`In allegato lo ${waiverDocumentName} firmato digitalmente per l'accesso al campo.`],
          rows: [
            { label: "Firmatario", value: input.signerName },
            { label: "Email", value: input.signerEmail },
            { label: "Prenotazione", value: formatEventSlot(input.booking) },
            { label: "Firmato il", value: formatEventDateTime(input.signedAt) },
          ],
        }),
      },
      toRecipients: [
        {
          emailAddress: {
            address: input.recipientEmail,
          },
        },
      ],
      attachments: [
        waiverPdfAttachment(input),
      ],
    },
    saveToSentItems: true,
  };
}

function waiverPdfAttachment(input: { pdfBytes: Uint8Array; filename: string }) {
  return {
    "@odata.type": "#microsoft.graph.fileAttachment",
    name: input.filename,
    contentType: "application/pdf",
    contentBytes: Buffer.from(input.pdfBytes).toString("base64"),
  };
}

function icsText(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function icsDate(date: Date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function guestCalendarAttachment(input: {
  booking: Booking;
  signerName: string;
  signerEmail: string;
  cancelUrl?: string;
}) {
  const description = [
    `Firma dello ${waiverDocumentName} registrata.`,
    input.cancelUrl ? `Se non puoi partecipare, rinuncia al posto qui: ${input.cancelUrl}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//TOPFLY//Padel TOPFLY//IT",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${icsText(`${input.booking.id}-${input.signerEmail}`)}@padel.topflysolutions.com`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(input.booking.start)}`,
    `DTEND:${icsDate(input.booking.end)}`,
    `SUMMARY:${icsText("Padel TOPFLY - Accesso campo")}`,
    `DESCRIPTION:${icsText(description)}`,
    "LOCATION:Campo Padel TOPFLY",
    `ATTENDEE;CN=${icsText(input.signerName)}:mailto:${input.signerEmail}`,
    // L'evento entra in calendario ma da solo non suona: il referente ha il promemoria Outlook,
    // gli ospiti no. Un VALARM DISPLAY a -PT60M da' anche a loro l'avviso un'ora prima. Vive solo
    // qui, nell'ICS di conferma (METHOD:PUBLISH): sulla cancellazione (METHOD:CANCEL) un allarme
    // non ha senso, l'evento sta sparendo.
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "TRIGGER:-PT60M",
    `DESCRIPTION:${icsText("Tra un'ora: accesso campo Padel TOPFLY")}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");

  return {
    "@odata.type": "#microsoft.graph.fileAttachment",
    name: "padel-topfly.ics",
    contentType: "text/calendar",
    contentBytes: Buffer.from(ics).toString("base64"),
  };
}

// Ritira dal calendario del singolo l'appuntamento mandato alla firma. Lo usano due mail che
// dicono cose diverse: la partita annullata per tutti, e la rinuncia del singolo a partita viva.
// La DESCRIPTION la decide il chiamante, altrimenti l'allegato smentisce il corpo del messaggio
// che se lo porta. La SUMMARY invece regge per entrambe: parla dell'accesso di chi legge, non
// della prenotazione.
function guestCancellationCalendarAttachment(input: {
  booking: Booking;
  signerName: string;
  signerEmail: string;
  description: string;
}) {
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//TOPFLY//Padel TOPFLY//IT",
    "CALSCALE:GREGORIAN",
    "METHOD:CANCEL",
    "BEGIN:VEVENT",
    `UID:${icsText(`${input.booking.id}-${input.signerEmail}`)}@padel.topflysolutions.com`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(input.booking.start)}`,
    `DTEND:${icsDate(input.booking.end)}`,
    "STATUS:CANCELLED",
    "SEQUENCE:1",
    `SUMMARY:${icsText("Padel TOPFLY - Accesso campo annullato")}`,
    `DESCRIPTION:${icsText(input.description)}`,
    "LOCATION:Campo Padel TOPFLY",
    `ATTENDEE;CN=${icsText(input.signerName)}:mailto:${input.signerEmail}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");

  return {
    "@odata.type": "#microsoft.graph.fileAttachment",
    name: "padel-topfly-annullamento.ics",
    contentType: "text/calendar; method=CANCEL",
    contentBytes: Buffer.from(ics).toString("base64"),
  };
}

function guestWaiverConfirmationPayload(input: {
  booking: Booking;
  signerName: string;
  signerEmail: string;
  signedAt: Date;
  cancelUrl?: string;
  pdfBytes?: Uint8Array;
  filename?: string;
}) {
  const waiverPdf =
    input.pdfBytes && input.filename ? { pdfBytes: input.pdfBytes, filename: input.filename } : null;

  return {
    message: {
      subject: mailSubject("Firma accesso campo confermata", input.booking),
      body: {
        contentType: "HTML",
        content: emailShell({
          preheader: `Firma registrata per la partita del ${formatEventSlot(input.booking)}.`,
          tone: "brand",
          title: "Firma accesso campo confermata",
          greeting: `Ciao ${input.signerName},`,
          body: ["la tua firma per l'accesso al campo Padel TOPFLY è stata registrata."],
          rows: [
            { label: "Giorno", value: formatEventDate(input.booking.start) },
            {
              label: "Orario",
              value: `${formatEventTime(input.booking.start)} - ${formatEventTime(input.booking.end)}`,
            },
            { label: "Firmato il", value: formatEventDateTime(input.signedAt) },
          ],
          notice: waiverPdf
            ? `In allegato trovi il PDF dello ${waiverDocumentName} firmato e un file calendario per tenere traccia dell'orario.`
            : "In allegato trovi un file calendario per tenere traccia dell'orario.",
          actions: input.cancelUrl
            ? [
                {
                  label: "Rinuncia al posto",
                  url: input.cancelUrl,
                  tone: "neutral",
                  hint: "Se non puoi essere presente, usa questo link",
                },
              ]
            : [],
        }),
      },
      toRecipients: [
        {
          emailAddress: {
            address: input.signerEmail,
            name: input.signerName,
          },
        },
      ],
      attachments: [
        guestCalendarAttachment(input),
        ...(waiverPdf ? [waiverPdfAttachment(waiverPdf)] : []),
      ],
    },
    saveToSentItems: true,
  };
}

function guestBookingUpdatedPayload(input: {
  previousBooking: Booking;
  booking: Booking;
  signerName: string;
  signerEmail: string;
  guestWaiverUrl?: string;
}) {
  const deadlineLabel = signatureDeadlineLabel(input.booking);

  return {
    message: {
      subject: mailSubject("Prenotazione modificata", input.booking),
      body: {
        contentType: "HTML",
        content: emailShell({
          preheader: `Nuovo orario ${formatEventSlot(input.booking)}: devi firmare di nuovo entro ${deadlineLabel}.`,
          title: "Prenotazione modificata",
          greeting: `Ciao ${input.signerName},`,
          body: ["la prenotazione Padel TOPFLY a cui avevi aderito è stata modificata."],
          rows: [
            { label: "Prima", value: formatEventSlot(input.previousBooking) },
            { label: "Nuovo orario", value: formatEventSlot(input.booking) },
            { label: "Referente", value: input.booking.organizerName },
            { label: "Firma entro", value: deadlineLabel },
          ],
          notice: `La firma precedente resta archiviata, ma per il nuovo orario serve firmare di nuovo. ${autoCancelWarning}`,
          actions: input.guestWaiverUrl
            ? [{ label: "Firma per il nuovo orario", url: input.guestWaiverUrl }]
            : [],
          footer: input.guestWaiverUrl ? undefined : "Chiedi al referente il nuovo link firma ospiti.",
        }),
      },
      toRecipients: [
        {
          emailAddress: {
            address: input.signerEmail,
            name: input.signerName,
          },
        },
      ],
    },
    saveToSentItems: true,
  };
}

function guestBookingCanceledPayload(input: {
  booking: Booking;
  signerName: string;
  signerEmail: string;
}) {
  return {
    message: {
      subject: mailSubject("Prenotazione annullata", input.booking),
      body: {
        contentType: "HTML",
        content: emailShell({
          preheader: `La partita del ${formatEventSlot(input.booking)} non si gioca più.`,
          tone: "danger",
          title: "Prenotazione annullata",
          greeting: `Ciao ${input.signerName},`,
          body: ["la prenotazione Padel TOPFLY a cui avevi aderito è stata annullata."],
          rows: [
            { label: "Giorno", value: formatEventDate(input.booking.start) },
            {
              label: "Orario",
              value: `${formatEventTime(input.booking.start)} - ${formatEventTime(input.booking.end)}`,
            },
            { label: "Referente", value: input.booking.organizerName },
          ],
          footer:
            "Non devi fare altro: il tuo posto non risulta più valido e il campo torna disponibile.",
        }),
      },
      toRecipients: [
        {
          emailAddress: {
            address: input.signerEmail,
            name: input.signerName,
          },
        },
      ],
      attachments: [
        guestCancellationCalendarAttachment({
          ...input,
          description: "Prenotazione campo Padel TOPFLY annullata.",
        }),
      ],
    },
    saveToSentItems: true,
  };
}

// Chi rinuncia esce da activeGuestSigners e non riceve piu' nessuna notifica sulla partita:
// senza questa mail resta l'unico con l'appuntamento della firma appeso in calendario. L'ICS di
// cancellazione condivide l'UID con quello mandato alla firma, quindi ritira proprio quell'evento.
function guestWithdrawalConfirmationPayload(input: {
  booking: Booking;
  signerName: string;
  signerEmail: string;
}) {
  const dateLabel = formatEventDate(input.booking.start);
  const startLabel = formatEventTime(input.booking.start);

  return {
    message: {
      subject: mailSubject("Rinuncia al posto confermata", input.booking),
      body: {
        contentType: "HTML",
        content: emailShell({
          preheader: `Sei fuori dalla partita del ${formatEventSlot(input.booking)}: l'appuntamento sparisce dal calendario.`,
          title: "Rinuncia al posto confermata",
          greeting: `Ciao ${input.signerName},`,
          body: [
            `hai rinunciato al posto per la partita del ${dateLabel} alle ${startLabel}. L'appuntamento viene rimosso dal tuo calendario.`,
          ],
          rows: [
            { label: "Giorno", value: dateLabel },
            {
              label: "Orario",
              value: `${startLabel} - ${formatEventTime(input.booking.end)}`,
            },
          ],
          footer: `Non devi fare altro. La firma che avevi registrato resta archiviata.`,
        }),
      },
      toRecipients: [
        {
          emailAddress: {
            address: input.signerEmail,
            name: input.signerName,
          },
        },
      ],
      // Qui la prenotazione e' viva: chi rinuncia esce dalla partita, la partita resta. L'ICS
      // ritira solo l'appuntamento di chi legge, e la DESCRIPTION deve dire quello.
      attachments: [
        guestCancellationCalendarAttachment({
          ...input,
          description: "Hai rinunciato al posto per questa partita di Padel TOPFLY.",
        }),
      ],
    },
    saveToSentItems: true,
  };
}

function organizerPendingSignaturePayload(input: {
  booking: Booking;
  signedCount: number;
  manageUrl?: string;
  guestWaiverUrl?: string;
  pdfBytes?: Uint8Array;
  filename?: string;
}) {
  const waiverPdf = input.pdfBytes && input.filename ? { pdfBytes: input.pdfBytes, filename: input.filename } : null;
  const deadlineLabel = signatureDeadlineLabel(input.booking);
  const progress = signatureProgressCopy({
    signedCount: input.signedCount,
    playerCount: input.booking.playerCount,
  });
  const actions: EmailAction[] = [];

  if (input.guestWaiverUrl) {
    actions.push({ label: "Link firma ospiti", url: input.guestWaiverUrl });
  }

  if (input.manageUrl) {
    actions.push({
      label: "Gestisci o annulla la prenotazione",
      url: input.manageUrl,
      tone: "neutral",
    });
  }

  return {
    message: {
      subject: mailSubject(pendingSignatureSubjectBase, input.booking),
      body: {
        contentType: "HTML",
        content: emailShell({
          preheader: `${progress.missingLabel}: scadenza ${deadlineLabel}.`,
          title: pendingSignatureSubjectBase,
          greeting: `Ciao ${input.booking.organizerName},`,
          body: [
            "la tua prenotazione è stata presa in carico ma non è ancora confermata.",
            ...(waiverPdf
              ? [`In allegato trovi il PDF del tuo ${waiverDocumentName} firmato.`]
              : []),
          ],
          rows: [
            { label: "Giorno", value: formatEventDate(input.booking.start) },
            {
              label: "Orario",
              value: `${formatEventTime(input.booking.start)} - ${formatEventTime(input.booking.end)}`,
            },
            { label: "Firme", value: progress.summary },
            { label: "Scadenza", value: deadlineLabel },
          ],
          notice: autoCancelWarning,
          actions,
          // Il reinvio dall'area admin non puo' ricostruire i link: i token sono salvati come
          // hash. Senza il link firma ospiti questa mail lascerebbe il referente a mani vuote
          // proprio sulla cosa che gli serve, quindi gli si dice dov'e' l'originale.
          footer: input.guestWaiverUrl
            ? undefined
            : "Il link firma ospiti da girare agli altri giocatori è nella tua prenotazione, dentro l'app Padel TOPFLY.",
        }),
      },
      toRecipients: [
        {
          emailAddress: {
            address: input.booking.organizerEmail,
            name: input.booking.organizerName,
          },
        },
      ],
      ...(waiverPdf ? { attachments: [waiverPdfAttachment(waiverPdf)] } : {}),
    },
    saveToSentItems: true,
  };
}

function organizerGuestWithdrewPayload(input: {
  booking: Booking;
  signerName: string;
  signedCount: number;
  guestWaiverUrl?: string;
}) {
  const deadlineLabel = signatureDeadlineLabel(input.booking);
  const progress = signatureProgressCopy({
    signedCount: input.signedCount,
    playerCount: input.booking.playerCount,
  });

  return {
    message: {
      subject: mailSubject(`${input.signerName} ha rinunciato al posto`, input.booking),
      body: {
        contentType: "HTML",
        content: emailShell({
          preheader: `${progress.missingLabel} per la partita del ${formatEventSlot(input.booking)}: serve un sostituto.`,
          title: `${input.signerName} ha rinunciato al posto`,
          greeting: `Ciao ${input.booking.organizerName},`,
          body: [
            `${input.signerName} non giocherà la partita del ${formatEventDate(input.booking.start)} alle ${formatEventTime(input.booking.start)}. La prenotazione resta valida, ma torna in attesa di firme.`,
          ],
          rows: [
            { label: "Giorno", value: formatEventDate(input.booking.start) },
            {
              label: "Orario",
              value: `${formatEventTime(input.booking.start)} - ${formatEventTime(input.booking.end)}`,
            },
            { label: "Firme", value: progress.summary },
            { label: "Scadenza", value: deadlineLabel },
          ],
          notice: `Trova un sostituto e fagli firmare lo ${waiverDocumentName} entro la scadenza. ${autoCancelWarning}`,
          actions: input.guestWaiverUrl
            ? [{ label: "Link firma ospiti", url: input.guestWaiverUrl }]
            : [],
          footer: input.guestWaiverUrl ? undefined : pendingSignatureMailReference,
        }),
      },
      toRecipients: [
        {
          emailAddress: {
            address: input.booking.organizerEmail,
            name: input.booking.organizerName,
          },
        },
      ],
    },
    saveToSentItems: true,
  };
}

function organizerSignatureReminderPayload(input: {
  booking: Booking;
  signedCount: number;
}) {
  const deadlineLabel = signatureDeadlineLabel(input.booking);
  const progress = signatureProgressCopy({
    signedCount: input.signedCount,
    playerCount: input.booking.playerCount,
  });

  return {
    message: {
      subject: mailSubject("Mancano firme per confermare", input.booking),
      body: {
        contentType: "HTML",
        content: emailShell({
          preheader: `${progress.missingLabel}: scadenza ${deadlineLabel}.`,
          title: "Mancano firme per confermare",
          greeting: `Ciao ${input.booking.organizerName},`,
          body: ["la prenotazione del campo Padel TOPFLY non è ancora confermata."],
          rows: [
            { label: "Giorno", value: formatEventDate(input.booking.start) },
            {
              label: "Orario",
              value: `${formatEventTime(input.booking.start)} - ${formatEventTime(input.booking.end)}`,
            },
            { label: "Firme", value: progress.summary },
            { label: "Scadenza", value: deadlineLabel },
          ],
          notice: autoCancelWarning,
          footer: pendingSignatureMailReference,
        }),
      },
      toRecipients: [
        {
          emailAddress: {
            address: input.booking.organizerEmail,
            name: input.booking.organizerName,
          },
        },
      ],
    },
    saveToSentItems: true,
  };
}

function organizerAutoCanceledPayload(input: {
  booking: Booking;
  signedCount: number;
}) {
  const progress = signatureProgressCopy({
    signedCount: input.signedCount,
    playerCount: input.booking.playerCount,
  });

  return {
    message: {
      subject: mailSubject("Prenotazione annullata per firme mancanti", input.booking),
      body: {
        contentType: "HTML",
        content: emailShell({
          preheader: `La partita del ${formatEventSlot(input.booking)} è annullata: alla scadenza le firme raccolte erano ${progress.collected}.`,
          tone: "danger",
          title: "Annullata: firme mancanti",
          greeting: `Ciao ${input.booking.organizerName},`,
          body: ["la prenotazione è stata annullata automaticamente per firme mancanti."],
          rows: [
            { label: "Giorno", value: formatEventDate(input.booking.start) },
            {
              label: "Orario",
              value: `${formatEventTime(input.booking.start)} - ${formatEventTime(input.booking.end)}`,
            },
            { label: "Firme", value: progress.summary },
          ],
          footer: "Il campo torna disponibile per gli altri colleghi. Per una nuova prenotazione usa l'app.",
        }),
      },
      toRecipients: [
        {
          emailAddress: {
            address: input.booking.organizerEmail,
            name: input.booking.organizerName,
          },
        },
      ],
    },
    saveToSentItems: true,
  };
}

// Il referente riceve la ricevuta anche quando annulla lui: la disdetta nativa di Outlook parte
// solo per le prenotazioni confermate, e' un messaggio di calendario e non dice il perche'.
// Chi ha annullato non compare mai per nome: l'annullamento e' un atto dell'amministrazione.
function organizerBookingCanceledPayload(input: { booking: Booking; actor: BookingCancelActor }) {
  const dateLabel = formatEventDate(input.booking.start);
  const startLabel = formatEventTime(input.booking.start);
  const bySelf = input.actor === "organizer";

  return {
    message: {
      subject: mailSubject(
        bySelf ? "Prenotazione annullata" : "Prenotazione annullata dall'amministrazione",
        input.booking,
      ),
      body: {
        contentType: "HTML",
        content: emailShell({
          preheader: bySelf
            ? `Hai annullato la partita del ${formatEventSlot(input.booking)}.`
            : `La partita del ${formatEventSlot(input.booking)} è stata annullata dall'amministrazione.`,
          tone: "danger",
          title: bySelf ? "Prenotazione annullata" : "Annullata dall'amministrazione",
          greeting: `Ciao ${input.booking.organizerName},`,
          body: [
            bySelf
              ? `hai annullato la prenotazione del ${dateLabel} alle ${startLabel}. Il campo torna disponibile per gli altri colleghi.`
              : `la tua prenotazione del ${dateLabel} alle ${startLabel} è stata annullata dall'amministrazione.`,
          ],
          rows: [
            { label: "Giorno", value: dateLabel },
            {
              label: "Orario",
              value: `${startLabel} - ${formatEventTime(input.booking.end)}`,
            },
          ],
          footer: bySelf
            ? "Per una nuova prenotazione usa l'app."
            : "Il campo torna disponibile per gli altri colleghi. Per una nuova prenotazione usa l'app.",
        }),
      },
      toRecipients: [
        {
          emailAddress: {
            address: input.booking.organizerEmail,
            name: input.booking.organizerName,
          },
        },
      ],
    },
    saveToSentItems: true,
  };
}

function cancelComment(organizer: OrganizerContact) {
  return [
    `Ciao ${organizer.name},`,
    "",
    "la tua prenotazione del campo Padel TOPFLY è stata annullata.",
    "Il campo torna disponibile per gli altri colleghi.",
  ].join("\n");
}

function pendingSignaturesComment(organizer: OrganizerContact) {
  return [
    `Ciao ${organizer.name},`,
    "",
    "L'appuntamento viene rimosso perché servono di nuovo le firme: la prenotazione resta valida,",
    "controlla l'email per i dettagli.",
  ].join("\n");
}

function mailboxPath(path: string) {
  return `/users/${encodeURIComponent(appConfig.graph.mailbox!)}${path}`;
}

export async function createOutlookEvent(
  booking: Booking,
  organizer: OrganizerContact,
  manageUrl?: string,
): Promise<GraphSyncResult> {
  const disabled = graphDisabled();
  if (disabled) return disabled;

  try {
    const response = await graphFetch(mailboxPath("/calendar/events"), {
      method: "POST",
      body: JSON.stringify(eventPayload(booking, organizer, manageUrl)),
    });
    const json = (await response.json()) as { id?: string };

    return { status: "SYNCED", eventId: json.id };
  } catch (error) {
    return {
      status: "FAILED",
      error: error instanceof Error ? error.message : "Graph create failed",
    };
  }
}

export async function updateOutlookEvent(
  booking: Booking,
  organizer: OrganizerContact,
  manageUrl?: string,
): Promise<GraphSyncResult> {
  if (!booking.outlookEventId) {
    return createOutlookEvent(booking, organizer, manageUrl);
  }

  const disabled = graphDisabled();
  if (disabled) return { ...disabled, eventId: booking.outlookEventId };

  try {
    await graphFetch(mailboxPath(`/events/${booking.outlookEventId}`), {
      method: "PATCH",
      body: JSON.stringify(eventPayload(booking, organizer, manageUrl)),
    });

    return { status: "SYNCED", eventId: booking.outlookEventId };
  } catch (error) {
    return {
      status: "FAILED",
      eventId: booking.outlookEventId,
      error: error instanceof Error ? error.message : "Graph update failed",
    };
  }
}

type WaiverMailInput = {
  booking: Booking;
  signerName: string;
  signerEmail: string;
  signedAt: Date;
  pdfBytes: Uint8Array;
  filename: string;
};

async function sendWaiverMailLeg(
  recipientEmail: string,
  input: WaiverMailInput,
): Promise<WaiverMailResult> {
  try {
    await graphFetch(mailboxPath("/sendMail"), {
      method: "POST",
      body: JSON.stringify(waiverMailPayload({ ...input, recipientEmail })),
    });

    return { status: "SENT" };
  } catch (error) {
    return {
      status: "FAILED",
      error: error instanceof Error ? error.message : "Graph sendMail failed",
    };
  }
}

export async function sendWaiverEmail(
  input: WaiverMailInput & {
    signerCopyEmail?: string;
    legs?: ReadonlyArray<WaiverMailLeg>;
  },
): Promise<WaiverMailLegResults> {
  const legs: ReadonlyArray<WaiverMailLeg> = input.legs ?? ["archive", "signer"];
  const disabled = graphDisabled();
  const results: WaiverMailLegResults = {};

  if (legs.includes("archive")) {
    results.archive = disabled
      ? { status: "SKIPPED", error: disabled.error }
      : await sendWaiverMailLeg(appConfig.waiver.recipientEmail, input);
  }

  if (legs.includes("signer")) {
    const signerCopyEmail = input.signerCopyEmail?.trim();
    // Senza destinatario, o quando coincide con l'archivio, non c'e' una seconda mail da
    // mandare: SKIPPED senza errore, come per le firme ospite.
    const needsSignerCopy =
      Boolean(signerCopyEmail) &&
      signerCopyEmail!.toLowerCase() !== appConfig.waiver.recipientEmail.toLowerCase();

    results.signer = !needsSignerCopy
      ? { status: "SKIPPED" }
      : disabled
        ? { status: "SKIPPED", error: disabled.error }
        : await sendWaiverMailLeg(signerCopyEmail!, input);
  }

  return results;
}

export async function sendGuestWaiverConfirmationEmail(input: {
  booking: Booking;
  signerName: string;
  signerEmail: string;
  signedAt: Date;
  cancelUrl?: string;
  pdfBytes?: Uint8Array;
  filename?: string;
}): Promise<WaiverMailResult> {
  const disabled = graphDisabled();
  if (disabled) {
    return { status: "SKIPPED", error: disabled.error };
  }

  try {
    await graphFetch(mailboxPath("/sendMail"), {
      method: "POST",
      body: JSON.stringify(guestWaiverConfirmationPayload(input)),
    });

    return { status: "SENT" };
  } catch (error) {
    return {
      status: "FAILED",
      error: error instanceof Error ? error.message : "Graph sendMail failed",
    };
  }
}

export async function sendGuestBookingUpdatedEmail(input: {
  previousBooking: Booking;
  booking: Booking;
  signerName: string;
  signerEmail: string;
  guestWaiverUrl?: string;
}): Promise<WaiverMailResult> {
  const disabled = graphDisabled();
  if (disabled) {
    return { status: "SKIPPED", error: disabled.error };
  }

  try {
    await graphFetch(mailboxPath("/sendMail"), {
      method: "POST",
      body: JSON.stringify(guestBookingUpdatedPayload(input)),
    });

    return { status: "SENT" };
  } catch (error) {
    return {
      status: "FAILED",
      error: error instanceof Error ? error.message : "Graph sendMail failed",
    };
  }
}

export async function sendGuestBookingCanceledEmail(input: {
  booking: Booking;
  signerName: string;
  signerEmail: string;
}): Promise<WaiverMailResult> {
  const disabled = graphDisabled();
  if (disabled) {
    return { status: "SKIPPED", error: disabled.error };
  }

  try {
    await graphFetch(mailboxPath("/sendMail"), {
      method: "POST",
      body: JSON.stringify(guestBookingCanceledPayload(input)),
    });

    return { status: "SENT" };
  } catch (error) {
    return {
      status: "FAILED",
      error: error instanceof Error ? error.message : "Graph sendMail failed",
    };
  }
}

export async function sendGuestWithdrawalConfirmationEmail(input: {
  booking: Booking;
  signerName: string;
  signerEmail: string;
}): Promise<WaiverMailResult> {
  const disabled = graphDisabled();
  if (disabled) {
    return { status: "SKIPPED", error: disabled.error };
  }

  try {
    await graphFetch(mailboxPath("/sendMail"), {
      method: "POST",
      body: JSON.stringify(guestWithdrawalConfirmationPayload(input)),
    });

    return { status: "SENT" };
  } catch (error) {
    return {
      status: "FAILED",
      error: error instanceof Error ? error.message : "Graph sendMail failed",
    };
  }
}

export async function sendOrganizerPendingSignatureEmail(input: {
  booking: Booking;
  signedCount: number;
  manageUrl?: string;
  guestWaiverUrl?: string;
  pdfBytes?: Uint8Array;
  filename?: string;
}): Promise<WaiverMailResult> {
  const disabled = graphDisabled();
  if (disabled) {
    return { status: "SKIPPED", error: disabled.error };
  }

  try {
    await graphFetch(mailboxPath("/sendMail"), {
      method: "POST",
      body: JSON.stringify(organizerPendingSignaturePayload(input)),
    });

    return { status: "SENT" };
  } catch (error) {
    return {
      status: "FAILED",
      error: error instanceof Error ? error.message : "Graph sendMail failed",
    };
  }
}

export async function sendOrganizerGuestWithdrewEmail(input: {
  booking: Booking;
  signerName: string;
  signedCount: number;
  guestWaiverUrl?: string;
}): Promise<WaiverMailResult> {
  const disabled = graphDisabled();
  if (disabled) {
    return { status: "SKIPPED", error: disabled.error };
  }

  try {
    await graphFetch(mailboxPath("/sendMail"), {
      method: "POST",
      body: JSON.stringify(organizerGuestWithdrewPayload(input)),
    });

    return { status: "SENT" };
  } catch (error) {
    return {
      status: "FAILED",
      error: error instanceof Error ? error.message : "Graph sendMail failed",
    };
  }
}

export async function sendOrganizerSignatureReminderEmail(input: {
  booking: Booking;
  signedCount: number;
}): Promise<WaiverMailResult> {
  const disabled = graphDisabled();
  if (disabled) {
    return { status: "SKIPPED", error: disabled.error };
  }

  try {
    await graphFetch(mailboxPath("/sendMail"), {
      method: "POST",
      body: JSON.stringify(organizerSignatureReminderPayload(input)),
    });

    return { status: "SENT" };
  } catch (error) {
    return {
      status: "FAILED",
      error: error instanceof Error ? error.message : "Graph sendMail failed",
    };
  }
}

export async function sendOrganizerAutoCanceledEmail(input: {
  booking: Booking;
  signedCount: number;
}): Promise<WaiverMailResult> {
  const disabled = graphDisabled();
  if (disabled) {
    return { status: "SKIPPED", error: disabled.error };
  }

  try {
    await graphFetch(mailboxPath("/sendMail"), {
      method: "POST",
      body: JSON.stringify(organizerAutoCanceledPayload(input)),
    });

    return { status: "SENT" };
  } catch (error) {
    return {
      status: "FAILED",
      error: error instanceof Error ? error.message : "Graph sendMail failed",
    };
  }
}

export async function sendOrganizerBookingCanceledEmail(input: {
  booking: Booking;
  actor: BookingCancelActor;
}): Promise<WaiverMailResult> {
  const disabled = graphDisabled();
  if (disabled) {
    return { status: "SKIPPED", error: disabled.error };
  }

  try {
    await graphFetch(mailboxPath("/sendMail"), {
      method: "POST",
      body: JSON.stringify(organizerBookingCanceledPayload(input)),
    });

    return { status: "SENT" };
  } catch (error) {
    return {
      status: "FAILED",
      error: error instanceof Error ? error.message : "Graph sendMail failed",
    };
  }
}

export async function deleteOutlookEvent(
  booking: Booking,
  variant: "canceled" | "pending" = "canceled",
): Promise<GraphSyncResult> {
  if (!booking.outlookEventId) {
    return { status: "SKIPPED", error: "Nessun evento Outlook collegato." };
  }

  const disabled = graphDisabled();
  if (disabled) return { ...disabled, eventId: booking.outlookEventId };

  try {
    const organizer = { email: booking.organizerEmail, name: booking.organizerName };
    const comment =
      variant === "pending" ? pendingSignaturesComment(organizer) : cancelComment(organizer);

    await graphFetch(mailboxPath(`/events/${booking.outlookEventId}/cancel`), {
      method: "POST",
      body: JSON.stringify({ comment }),
    });

    return { status: "SYNCED", eventId: booking.outlookEventId };
  } catch (error) {
    return {
      status: "FAILED",
      eventId: booking.outlookEventId,
      error: error instanceof Error ? error.message : "Graph delete failed",
    };
  }
}
