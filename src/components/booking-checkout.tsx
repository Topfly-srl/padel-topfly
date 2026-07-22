"use client";

import { ArrowLeft, CalendarDays, Check, Clock3, FileText, Users } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { appPath } from "@/lib/app-path";
import { birthDateInputToIsoDate } from "@/lib/birth-date-input";
import { dateTimeFromParts, localTime } from "@/lib/booking-ui";
import { isValidEmail, normalizeEmailInput } from "@/lib/email";
import { buildShortGuestWaiverLink } from "@/lib/guest-waiver-link";
import { PendingSignaturePanel } from "@/components/pending-signature-panel";
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
type CheckoutStep = 1 | 2;

type CreatedBooking = {
  id: string;
  start: string;
  end: string;
  status: "PENDING_SIGNATURES" | "CONFIRMED" | "CANCELED";
  organizerName: string;
  playerCount: number;
  waiverSignedCount: number;
  outlookSyncStatus: "PENDING" | "SYNCED" | "FAILED" | "SKIPPED";
  waiverEmailStatus: "PENDING" | "SENT" | "FAILED" | "SKIPPED" | null;
  signatureDeadlineAt: string | null;
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

function localSummaryDay(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("it-IT", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    timeZone,
  }).format(date);
}

function playerCountLabel(count: number) {
  return `${count} ${count === 1 ? "giocatore" : "giocatori"}`;
}

function normalizeName(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

async function readApiError(response: Response) {
  const json = (await response.json().catch(() => null)) as { error?: string } | null;
  return json?.error ?? "Richiesta non riuscita.";
}

// Mostrato quando fetch lancia (rete assente), non quando la risposta e' un errore applicativo.
const networkErrorText = "Rete non disponibile. Controlla la connessione e riprova.";

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
  timeZone,
}: {
  selectedDate: string;
  selectedTime: string;
  duration: number;
  allowedDomain: string;
  // Fuso del campo, passato dalla pagina server (appConfig.timeZone): il checkout non carica
  // l'availability, ma gli orari restano "di parete" e non devono seguire il dispositivo.
  timeZone: string;
}) {
  const [organizerName, setOrganizerName] = useState("");
  const [organizerEmail, setOrganizerEmail] = useState("");
  const [playerCount, setPlayerCount] = useState(4);
  const [waiverForm, setWaiverForm] = useState<WaiverFormValue>(emptyWaiverForm);
  const [checkoutStep, setCheckoutStep] = useState<CheckoutStep>(1);
  const [touchedFields, setTouchedFields] = useState<Partial<Record<CheckoutField, boolean>>>({});
  const [bookingStepAttempted, setBookingStepAttempted] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [createdBooking, setCreatedBooking] = useState<CreatedBooking | null>(null);
  const [copiedGuestWaiverLink, setCopiedGuestWaiverLink] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const checkoutCardRef = useRef<HTMLElement | null>(null);
  const organizerNameErrorId = useId();
  const organizerEmailErrorId = useId();

  const start = useMemo(
    () => dateTimeFromParts(selectedDate, selectedTime, timeZone),
    [selectedDate, selectedTime, timeZone],
  );
  const end = useMemo(() => addMinutes(start, duration), [duration, start]);
  const normalizedOrganizerName = normalizeName(organizerName);
  const normalizedOrganizerEmail = normalizeEmailInput(organizerEmail);
  const birthDateIso = birthDateInputToIsoDate(waiverForm.birthDate);
  const canContinueBooking =
    normalizedOrganizerName.length > 1 &&
    isValidEmail(normalizedOrganizerEmail) &&
    playerCount >= 1 &&
    playerCount <= 4;
  const canSubmit =
    canContinueBooking &&
    Boolean(birthDateIso) &&
    waiverForm.birthPlace.trim().length > 1 &&
    waiverForm.isAdultConfirmed &&
    waiverForm.privacyAccepted &&
    waiverForm.regulationAccepted &&
    waiverForm.liabilityAccepted &&
    waiverForm.specificApprovalAccepted &&
    Boolean(waiverForm.signatureImageDataUrl);
  const markTouched = (field: CheckoutField) => {
    setTouchedFields((current) => ({ ...current, [field]: true }));
  };
  const isBookingField = (field: CheckoutField) =>
    field === "organizerName" || field === "organizerEmail" || field === "playerCount";
  const showFieldError = (field: CheckoutField, invalid: boolean) =>
    invalid &&
    (submitAttempted ||
      Boolean(touchedFields[field]) ||
      (bookingStepAttempted && isBookingField(field)));
  const missingCopy = canSubmit
    ? "Tutto pronto: puoi confermare la prenotazione."
    : "Completa i campi mancanti per continuare.";
  const organizerNameInvalid = showFieldError("organizerName", normalizedOrganizerName.length < 2);
  const organizerEmailInvalid = showFieldError("organizerEmail", !isValidEmail(normalizedOrganizerEmail));
  const pendingMissingSignatures = createdBooking
    ? Math.max(0, createdBooking.playerCount - createdBooking.waiverSignedCount)
    : 0;

  useEffect(() => {
    if (!submitAttempted || canSubmit) return;

    window.requestAnimationFrame(() => {
      checkoutCardRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    });
  }, [canSubmit, submitAttempted]);

  async function copyGuestWaiverLink(linkOverride?: string) {
    const link = linkOverride ?? createdBooking?.guestWaiverUrl;
    if (!link) return;

    const shareLink = buildShortGuestWaiverLink(link, window.location.origin);
    const copied = await writeClipboardText(shareLink);
    setCopiedGuestWaiverLink(copied);
    setNotice({
      type: copied ? "success" : "warning",
      text: copied
        ? "Link firma ospiti copiato."
        : "Copia automatica non riuscita. Apri il link e copialo dalla barra indirizzi.",
    });
  }

  function focusFirstInvalidField() {
    window.requestAnimationFrame(() => {
      checkoutCardRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    });
  }

  function continueToWaiverStep() {
    setNotice(null);
    setBookingStepAttempted(true);

    if (!canContinueBooking) {
      setNotice({ type: "warning", text: "Completa i dati della prenotazione per continuare." });
      focusFirstInvalidField();
      return;
    }

    setOrganizerName(normalizedOrganizerName);
    setOrganizerEmail(normalizedOrganizerEmail);
    setCheckoutStep(2);
    setNotice(null);
    window.requestAnimationFrame(() => {
      checkoutCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  async function submitBooking() {
    setNotice(null);

    if (!canSubmit || !birthDateIso) {
      if (!canContinueBooking) {
        setCheckoutStep(1);
        setBookingStepAttempted(true);
      }
      setSubmitAttempted(true);
      setNotice({ type: "warning", text: "Completa i campi obbligatori prima di prenotare." });
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await fetch(appPath("/api/bookings"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start: start.toISOString(),
          end: end.toISOString(),
          organizerName,
          organizerEmail: normalizedOrganizerEmail,
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
      setNotice(
        json.booking.status === "PENDING_SIGNATURES"
          ? null
          : {
              type: "success",
              text: "Prenotazione confermata.",
            },
      );
    } catch {
      setNotice({ type: "error", text: networkErrorText });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="app-shell checkout-shell">
      <header className="checkout-topbar">
        <Link className="checkout-back" href="/" aria-label="Torna al calendario">
          <ArrowLeft size={17} />
        </Link>
        <div className="brand-lockup">
          <Image src={appPath("/topfly-logo.png")} alt="TOPFLY GPS solutions" width={678} height={147} priority />
          <div>
            <p className="muted-label">Padel aziendale</p>
            <h1>
              {createdBooking
                ? createdBooking.status === "PENDING_SIGNATURES"
                  ? "Prenotazione provvisoria"
                  : "Prenotazione confermata"
                : "Prenota e firma"}
            </h1>
          </div>
        </div>
      </header>

      <section className="checkout-card" ref={checkoutCardRef}>
        <div className="checkout-recap">
          <div className="checkout-recap-copy">
            <span className="checkout-kicker">
              <CalendarDays size={15} />
              Prenotazione
            </span>
            <h2>{localSummaryDay(start, timeZone)}</h2>
            <div className="checkout-meta">
              <span>
                <Clock3 size={15} />
                {localTime(start, timeZone)} - {localTime(end, timeZone)}
              </span>
              <span>
                <Users size={15} />
                {playerCountLabel(playerCount)}
              </span>
              <span>{duration} min</span>
            </div>
          </div>
        </div>

        {!createdBooking ? (
          <div className="checkout-stepper" aria-label="Avanzamento prenotazione">
            <button
              aria-current={checkoutStep === 1 ? "step" : undefined}
              className={checkoutStep === 1 ? "active" : "done"}
              onClick={() => {
                setCheckoutStep(1);
                setNotice(null);
              }}
              type="button"
            >
              <span>1</span>
              Prenotazione
            </button>
            <button
              aria-current={checkoutStep === 2 ? "step" : undefined}
              className={checkoutStep === 2 ? "active" : ""}
              onClick={continueToWaiverStep}
              type="button"
            >
              <span>2</span>
              Scarico e firma
            </button>
          </div>
        ) : null}

        {notice ? (
          <div
            aria-live={notice.type === "error" ? "assertive" : "polite"}
            className={`notice ${notice.type}`}
            role={notice.type === "error" ? "alert" : "status"}
          >
            {notice.text}
          </div>
        ) : null}

        {createdBooking ? (
          <div className="checkout-success-flow">
            {createdBooking.status === "PENDING_SIGNATURES" ? null : (
              <>
                <div className="checkout-success-head">
                  <span className="summary-state-icon success" aria-hidden="true">
                    <Check size={18} />
                  </span>
                  <div>
                    <h2>Prenotazione confermata</h2>
                    <p>{localTime(start, timeZone)} - {localTime(end, timeZone)}</p>
                  </div>
                </div>

                <div className="checkout-status-row">
                  <span>
                    <FileText size={16} />
                    {createdBooking.waiverEmailStatus === "SENT"
                      ? "PDF inviato alla Direzione"
                      : "PDF salvato in archivio"}
                  </span>
                </div>
              </>
            )}

            {createdBooking.status === "PENDING_SIGNATURES" ? (
              <PendingSignaturePanel
                missingSignatures={pendingMissingSignatures}
                signatureDeadlineAt={createdBooking.signatureDeadlineAt}
                timeZone={timeZone}
                guestWaiverLink={createdBooking.guestWaiverUrl ?? null}
                linkCopied={copiedGuestWaiverLink}
                onCopyLink={copyGuestWaiverLink}
                footnote={{
                  success: createdBooking.waiverEmailStatus === "SENT",
                  text:
                    createdBooking.waiverEmailStatus === "SENT"
                      ? "PDF inviato alla Direzione."
                      : "PDF referente salvato.",
                }}
              />
            ) : null}

            <Link className="ghost-button full-width" href="/">
              <ArrowLeft size={16} />
              Torna al calendario
            </Link>
          </div>
        ) : (
          <div className="checkout-flow">
            {checkoutStep === 1 ? (
              <section className="checkout-section">
                <div className="checkout-field-grid">
                  <label>
                    Nome e cognome
                    <input
                      autoComplete="name"
                      required
                      aria-invalid={organizerNameInvalid || undefined}
                      aria-describedby={organizerNameInvalid ? organizerNameErrorId : undefined}
                      value={organizerName}
                      onBlur={() => markTouched("organizerName")}
                      onChange={(event) => setOrganizerName(event.target.value)}
                      placeholder="Mario Rossi"
                    />
                    {organizerNameInvalid ? (
                      <span className="sr-only" id={organizerNameErrorId}>
                        Inserisci nome e cognome.
                      </span>
                    ) : null}
                  </label>
                  <label>
                    Email
                    <input
                      autoComplete="email"
                      inputMode="email"
                      required
                      type="email"
                      aria-invalid={organizerEmailInvalid || undefined}
                      aria-describedby={organizerEmailInvalid ? organizerEmailErrorId : undefined}
                      value={organizerEmail}
                      onBlur={() => {
                        markTouched("organizerEmail");
                        setOrganizerEmail(normalizedOrganizerEmail);
                      }}
                      onChange={(event) => setOrganizerEmail(event.target.value)}
                      placeholder={`nome@${allowedDomain}`}
                    />
                    {organizerEmailInvalid ? (
                      <span className="sr-only" id={organizerEmailErrorId}>
                        {"Inserisci un'email valida."}
                      </span>
                    ) : null}
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
                      {[1, 2, 3, 4].map((count) => (
                        <option key={count} value={count}>
                          {playerCountLabel(count)}
                        </option>
                      ))}
                    </select>
                    <small>Puoi prenotare anche per allenarti in autonomia.</small>
                  </label>
                </div>
                <div className="checkout-step-actions">
                  <button className="primary-button full-width" onClick={continueToWaiverStep} type="button">
                    Continua
                  </button>
                </div>
              </section>
            ) : (
              <section className="checkout-section checkout-submit-panel">
                <WaiverFormSection
                  birthDateIsValid={Boolean(birthDateIso)}
                  compact
                  helperText="Modulo e regolamento saranno allegati al PDF firmato."
                  layout="checkout"
                  regulationUrl={appPath("/legal/regolamento-padel-topfly-v1.pdf")}
                  templateUrl={appPath("/legal/modulo-responsabilita-padel-template-v1.pdf")}
                  showErrors={submitAttempted}
                  signerName={normalizedOrganizerName}
                  touched={touchedFields}
                  value={waiverForm}
                  onChange={setWaiverForm}
                  onTouched={markTouched}
                />
                {submitAttempted || canSubmit ? (
                  <small className={`form-submit-hint ${canSubmit ? "success" : ""}`}>
                    {missingCopy}
                  </small>
                ) : null}
                <div className="checkout-step-actions split">
                  <button
                    className="ghost-button full-width"
                    onClick={() => {
                      setCheckoutStep(1);
                      setNotice(null);
                    }}
                    type="button"
                  >
                    Indietro
                  </button>
                  <button
                    className="primary-button full-width"
                    disabled={isSubmitting}
                    onClick={submitBooking}
                    type="button"
                  >
                    <Check size={18} />
                    {isSubmitting ? "Creo..." : "Firma e crea prenotazione provvisoria"}
                  </button>
                </div>
              </section>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
