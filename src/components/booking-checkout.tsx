"use client";

import { ArrowLeft, CalendarDays, Check, Clock3, FileText, Send, Users } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useMemo, useState } from "react";
import { appPath } from "@/lib/app-path";
import { birthDateInputToIsoDate } from "@/lib/birth-date-input";
import { GuestLinkPanel } from "@/components/guest-link-panel";
import {
  WaiverFormSection,
  type WaiverField,
  type WaiverFormValue,
} from "@/components/waiver-form-section";

type Notice = {
  type: "success" | "error" | "info" | "warning";
  text: string;
};

type CheckoutField = "organizerName" | "organizerEmail" | "playerCount" | WaiverField;

type CreatedBooking = {
  id: string;
  start: string;
  end: string;
  organizerName: string;
  playerCount: number;
  waiverSignedCount: number;
  outlookSyncStatus: "PENDING" | "SYNCED" | "FAILED" | "SKIPPED";
  waiverEmailStatus: "PENDING" | "SENT" | "FAILED" | "SKIPPED" | null;
  manageToken?: string;
  guestWaiverUrl?: string;
};

const tokenStorageKey = "topfly-padel.tokens.v1";
const guestWaiverLinksStorageKey = "topfly-padel.guest-waiver-links.v1";

const emptyWaiverForm: WaiverFormValue = {
  birthDate: "",
  birthPlace: "",
  isAdultConfirmed: false,
  privacyAccepted: false,
  regulationAccepted: false,
  liabilityAccepted: false,
  specificApprovalAccepted: false,
  signatureImageDataUrl: "",
};

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60_000);
}

function dateTimeFromParts(day: string, time: string) {
  return new Date(`${day}T${time}:00`);
}

function localTime(date: Date) {
  return new Intl.DateTimeFormat("it-IT", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function localSummaryDay(date: Date) {
  return new Intl.DateTimeFormat("it-IT", {
    weekday: "long",
    day: "2-digit",
    month: "long",
  }).format(date);
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function normalizeName(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

async function readApiError(response: Response) {
  const json = (await response.json().catch(() => null)) as { error?: string } | null;
  return json?.error ?? "Richiesta non riuscita.";
}

function readStoredTokens() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(tokenStorageKey) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((token): token is string => typeof token === "string") : [];
  } catch {
    return [];
  }
}

function rememberToken(token: string) {
  const nextTokens = [token, ...readStoredTokens().filter((item) => item !== token)].slice(0, 30);
  window.localStorage.setItem(tokenStorageKey, JSON.stringify(nextTokens));
}

function rememberGuestWaiverLink(bookingId: string, link: string) {
  let currentLinks: Record<string, string> = {};

  try {
    const parsed = JSON.parse(window.localStorage.getItem(guestWaiverLinksStorageKey) ?? "{}") as unknown;
    currentLinks = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    currentLinks = {};
  }

  window.localStorage.setItem(guestWaiverLinksStorageKey, JSON.stringify({ ...currentLinks, [bookingId]: link }));
}

async function writeClipboardText(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the textarea fallback below.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  try {
    return document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
}

export function BookingCheckout({
  selectedDate,
  selectedTime,
  duration,
  allowedDomain,
  environmentLabel = "",
}: {
  selectedDate: string;
  selectedTime: string;
  duration: number;
  allowedDomain: string;
  environmentLabel?: string;
}) {
  const [organizerName, setOrganizerName] = useState("");
  const [organizerEmail, setOrganizerEmail] = useState("");
  const [playerCount, setPlayerCount] = useState(4);
  const [waiverForm, setWaiverForm] = useState<WaiverFormValue>(emptyWaiverForm);
  const [touchedFields, setTouchedFields] = useState<Partial<Record<CheckoutField, boolean>>>({});
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [createdBooking, setCreatedBooking] = useState<CreatedBooking | null>(null);
  const [copiedGuestWaiverLink, setCopiedGuestWaiverLink] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const start = useMemo(() => dateTimeFromParts(selectedDate, selectedTime), [selectedDate, selectedTime]);
  const end = useMemo(() => addMinutes(start, duration), [duration, start]);
  const normalizedOrganizerName = normalizeName(organizerName);
  const birthDateIso = birthDateInputToIsoDate(waiverForm.birthDate);
  const canSubmit =
    normalizedOrganizerName.length > 1 &&
    isValidEmail(organizerEmail) &&
    playerCount >= 2 &&
    playerCount <= 4 &&
    Boolean(birthDateIso) &&
    waiverForm.birthPlace.trim().length > 1 &&
    waiverForm.isAdultConfirmed &&
    waiverForm.privacyAccepted &&
    waiverForm.regulationAccepted &&
    waiverForm.liabilityAccepted &&
    waiverForm.specificApprovalAccepted &&
    Boolean(waiverForm.signatureImageDataUrl);
  const missingFields = useMemo(() => {
    const missing: string[] = [];
    if (normalizedOrganizerName.length < 2) missing.push("nome e cognome");
    if (!isValidEmail(organizerEmail)) missing.push("email valida");
    if (!birthDateIso) missing.push("data di nascita");
    if (waiverForm.birthPlace.trim().length < 2) missing.push("luogo di nascita");
    if (!waiverForm.isAdultConfirmed) missing.push("maggiore eta");
    if (!waiverForm.privacyAccepted) missing.push("privacy");
    if (!waiverForm.regulationAccepted) missing.push("regolamento");
    if (!waiverForm.liabilityAccepted) missing.push("responsabilita");
    if (!waiverForm.specificApprovalAccepted) missing.push("clausole specifiche");
    if (!waiverForm.signatureImageDataUrl) missing.push("firma nel riquadro");
    return missing;
  }, [
    birthDateIso,
    normalizedOrganizerName.length,
    organizerEmail,
    waiverForm.birthPlace,
    waiverForm.isAdultConfirmed,
    waiverForm.liabilityAccepted,
    waiverForm.privacyAccepted,
    waiverForm.regulationAccepted,
    waiverForm.signatureImageDataUrl,
    waiverForm.specificApprovalAccepted,
  ]);

  const markTouched = (field: CheckoutField) => {
    setTouchedFields((current) => ({ ...current, [field]: true }));
  };
  const showFieldError = (field: CheckoutField, invalid: boolean) =>
    invalid && (submitAttempted || Boolean(touchedFields[field]));
  const missingCopy = canSubmit
    ? "Tutto pronto: confermiamo la prenotazione e inviamo il PDF."
    : `Manca: ${missingFields.slice(0, 3).join(", ")}${missingFields.length > 3 ? "..." : ""}.`;

  async function copyGuestWaiverLink(linkOverride?: string) {
    const link = linkOverride ?? createdBooking?.guestWaiverUrl;
    if (!link) return;

    const copied = await writeClipboardText(link);
    setCopiedGuestWaiverLink(copied);
    setNotice({
      type: copied ? "success" : "warning",
      text: copied ? "Link firma ospiti copiato." : "Copia automatica non riuscita. Seleziona il link manualmente.",
    });
  }

  async function submitBooking() {
    setNotice(null);

    if (!canSubmit || !birthDateIso) {
      setSubmitAttempted(true);
      setNotice({ type: "warning", text: "Completa i campi obbligatori prima di prenotare." });
      return;
    }

    setIsSubmitting(true);
    const response = await fetch(appPath("/api/bookings"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        start: start.toISOString(),
        end: end.toISOString(),
        organizerName,
        organizerEmail,
        playerCount,
        waiver: {
          birthDate: birthDateIso,
          birthPlace: waiverForm.birthPlace,
          isAdultConfirmed: waiverForm.isAdultConfirmed,
          privacyAccepted: waiverForm.privacyAccepted,
          regulationAccepted: waiverForm.regulationAccepted,
          liabilityAccepted: waiverForm.liabilityAccepted,
          specificApprovalAccepted: waiverForm.specificApprovalAccepted,
          signatureImageDataUrl: waiverForm.signatureImageDataUrl,
        },
      }),
    });
    setIsSubmitting(false);

    if (!response.ok) {
      setNotice({ type: "error", text: await readApiError(response) });
      return;
    }

    const json = (await response.json()) as { booking: CreatedBooking };
    if (json.booking.manageToken) {
      rememberToken(json.booking.manageToken);
    }
    if (json.booking.guestWaiverUrl) {
      rememberGuestWaiverLink(json.booking.id, json.booking.guestWaiverUrl);
    }

    setCreatedBooking(json.booking);
    setNotice({
      type: json.booking.outlookSyncStatus === "FAILED" ? "warning" : "success",
      text:
        json.booking.outlookSyncStatus === "FAILED"
          ? "Prenotazione confermata. L'invito Outlook non e' stato inviato."
          : "Prenotazione confermata.",
    });
  }

  return (
    <main className="app-shell checkout-shell">
      <header className="checkout-topbar">
        <Link className="checkout-back" href="/" aria-label="Torna al calendario">
          <ArrowLeft size={17} />
        </Link>
        <div className="brand-lockup">
          <Image src="/topfly-logo.png" alt="TOPFLY GPS solutions" width={678} height={147} priority />
          <div>
            <p className="muted-label">Padel aziendale</p>
            <h1>{createdBooking ? "Prenotazione confermata" : "Completa prenotazione"}</h1>
            {environmentLabel ? <span className="environment-badge">{environmentLabel}</span> : null}
          </div>
        </div>
      </header>

      <section className="checkout-card">
        <div className="checkout-recap">
          <div className="checkout-recap-copy">
            <span className="checkout-kicker">
              <CalendarDays size={15} />
              Campo prenotato
            </span>
            <h2>{localSummaryDay(start)}</h2>
            <div className="checkout-meta">
              <span>
                <Clock3 size={15} />
                {localTime(start)} - {localTime(end)}
              </span>
              <span>
                <Users size={15} />
                {playerCount} giocatori
              </span>
            </div>
          </div>
          <span className="checkout-duration">{duration} min</span>
        </div>

        {!createdBooking ? (
          <p className="checkout-intro">Controlla i dati, firma lo scarico e conferma. Il PDF resta archiviato.</p>
        ) : null}

        {notice ? <div className={`notice ${notice.type}`}>{notice.text}</div> : null}

        {createdBooking ? (
          <div className="checkout-success-flow">
            <div className="checkout-success-head">
              <span className="summary-state-icon success" aria-hidden="true">
                <Check size={18} />
              </span>
              <div>
                <h2>Prenotazione confermata</h2>
                <p>
                  {localTime(start)} - {localTime(end)} · Firme scarico{" "}
                  {createdBooking.waiverSignedCount}/{createdBooking.playerCount}
                </p>
              </div>
            </div>

            <div className="checkout-status-row">
              <span>
                <FileText size={16} />
                {createdBooking.waiverEmailStatus === "SENT"
                  ? "PDF inviato alla Direzione"
                  : "PDF salvato in archivio"}
              </span>
              <span>
                <Users size={16} />
                {createdBooking.waiverSignedCount}/{createdBooking.playerCount} firme
              </span>
            </div>

            {createdBooking.guestWaiverUrl ? (
              <section className="checkout-guest-share">
                <div className="checkout-section-title plain">
                  <div>
                    <strong>Invia il link agli ospiti</strong>
                    <small>Chi gioca con te firma da questo link.</small>
                  </div>
                </div>
                <GuestLinkPanel
                  copied={copiedGuestWaiverLink}
                  environmentLabel={environmentLabel}
                  link={createdBooking.guestWaiverUrl}
                  onCopy={copyGuestWaiverLink}
                />
              </section>
            ) : null}

            <Link className="ghost-button full-width" href="/">
              <ArrowLeft size={16} />
              Torna al calendario
            </Link>
          </div>
        ) : (
          <div className="checkout-flow">
            <section className="checkout-section">
              <div className="checkout-section-title">
                <span>1</span>
                <div>
                  <strong>Referente</strong>
                  <small>Dati per conferma e link ospiti.</small>
                </div>
              </div>
              <div className="checkout-field-grid">
                <label>
                  Nome e cognome
                  <input
                    autoComplete="name"
                    required
                    aria-invalid={showFieldError("organizerName", normalizedOrganizerName.length < 2) || undefined}
                    value={organizerName}
                    onBlur={() => markTouched("organizerName")}
                    onChange={(event) => setOrganizerName(event.target.value)}
                    placeholder="Mario Rossi"
                  />
                </label>
                <label>
                  Email
                  <input
                    autoComplete="email"
                    inputMode="email"
                    required
                    type="email"
                    aria-invalid={showFieldError("organizerEmail", !isValidEmail(organizerEmail)) || undefined}
                    value={organizerEmail}
                    onBlur={() => markTouched("organizerEmail")}
                    onChange={(event) => setOrganizerEmail(event.target.value)}
                    placeholder={`nome@${allowedDomain}`}
                  />
                </label>
                <label>
                  Giocatori
                  <select
                    value={playerCount}
                    onBlur={() => markTouched("playerCount")}
                    onChange={(event) => {
                      markTouched("playerCount");
                      setPlayerCount(Number(event.target.value));
                    }}
                  >
                    {[2, 3, 4].map((count) => (
                      <option key={count} value={count}>
                        {count} giocatori
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </section>

            <section className="checkout-section">
              <div className="checkout-section-title">
                <span>2</span>
                <div>
                  <strong>Scarico responsabilita</strong>
                  <small>PDF ufficiale, conferme e firma.</small>
                </div>
              </div>
              <WaiverFormSection
                birthDateIsValid={Boolean(birthDateIso)}
                compact
                helperText="Modulo e regolamento restano allegati al PDF firmato."
                layout="checkout"
                regulationUrl={appPath("/legal/regolamento-padel-topfly-v1.pdf")}
                templateUrl={appPath("/legal/modulo-responsabilita-padel-template-v1.pdf")}
                showErrors={submitAttempted}
                signerName={organizerName}
                touched={touchedFields}
                value={waiverForm}
                onChange={setWaiverForm}
                onTouched={markTouched}
              />
            </section>

            <div className="checkout-submit-panel">
              <small className={`form-submit-hint ${canSubmit ? "success" : ""}`}>
                {missingCopy}
              </small>
              <button
                className="primary-button full-width"
                disabled={!canSubmit || isSubmitting}
                onClick={submitBooking}
                type="button"
              >
                {isSubmitting ? <Check size={18} /> : <Send size={18} />}
                {isSubmitting ? "Confermo..." : "Conferma e invia PDF"}
              </button>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
