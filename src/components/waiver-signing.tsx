"use client";

import { Check, MailWarning } from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { appPath } from "@/lib/app-path";
import { birthDateInputToIsoDate } from "@/lib/birth-date-input";
import { isValidEmail, normalizeEmailInput } from "@/lib/email";
import {
  WaiverFormSection,
  type WaiverField,
  type WaiverFormValue,
} from "@/components/waiver-form-section";

type WaiverContext = {
  booking: {
    id: string;
    start: string;
    end: string;
    organizerName: string;
    playerCount: number;
    waiverRevision: number;
    waiverSignedCount: number;
    remainingSignatures: number;
    documentVersion: string;
    regulationUrl: string;
  };
};

type Notice = {
  type: "success" | "error" | "info" | "warning";
  text: string;
};

type GuestField = "signerName" | "signerEmail" | WaiverField;
type GuestStep = 1 | 2;

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

function localDateTime(date: Date) {
  return new Intl.DateTimeFormat("it-IT", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function localTime(date: Date) {
  return new Intl.DateTimeFormat("it-IT", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

async function readApiError(response: Response) {
  const json = (await response.json().catch(() => null)) as { error?: string } | null;
  return json?.error ?? "Richiesta non riuscita.";
}

function friendlyLoadError(message: string) {
  if (message.includes("non valido") || message.includes("scaduto")) {
    return "Link firma ospiti non valido o scaduto. Chiedi al referente della prenotazione di rimandarti il link corretto.";
  }
  if (message.includes("non e' piu' attiva")) {
    return "Questa prenotazione non e' piu' attiva. Non serve firmare questo scarico.";
  }
  if (message.includes("Prenotazione non trovata")) {
    return "Prenotazione non trovata. Controlla di aver aperto il link completo ricevuto dal referente.";
  }
  return message;
}

export function WaiverSigning({
  bookingId,
  token,
}: {
  bookingId: string;
  token: string;
}) {
  const [waiver, setWaiver] = useState<WaiverContext | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [signerName, setSignerName] = useState("");
  const [signerEmail, setSignerEmail] = useState("");
  const [waiverForm, setWaiverForm] = useState<WaiverFormValue>(emptyWaiverForm);
  const [guestStep, setGuestStep] = useState<GuestStep>(1);
  const [touchedFields, setTouchedFields] = useState<Partial<Record<GuestField, boolean>>>({});
  const [identityStepAttempted, setIdentityStepAttempted] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [hasSigned, setHasSigned] = useState(false);
  const [isPending, startTransition] = useTransition();
  const waiverCardRef = useRef<HTMLElement | null>(null);

  const birthDateIso = birthDateInputToIsoDate(waiverForm.birthDate);
  const normalizedSignerName = signerName.trim().replace(/\s+/g, " ");
  const normalizedSignerEmail = normalizeEmailInput(signerEmail);
  const canContinueGuest =
    normalizedSignerName.length > 1 &&
    isValidEmail(normalizedSignerEmail);
  const canSubmit =
    !isPending &&
    waiver &&
    waiver.booking.remainingSignatures > 0 &&
    canContinueGuest &&
    Boolean(birthDateIso) &&
    waiverForm.birthPlace.trim().length > 1 &&
    waiverForm.isAdultConfirmed &&
    waiverForm.privacyAccepted &&
    waiverForm.regulationAccepted &&
    waiverForm.liabilityAccepted &&
    waiverForm.specificApprovalAccepted &&
    Boolean(waiverForm.signatureImageDataUrl);
  const missingCopy = canSubmit
    ? "Tutto pronto: puoi firmare."
    : "Completa i campi mancanti per continuare.";

  const bookingStart = useMemo(() => (waiver ? new Date(waiver.booking.start) : null), [waiver]);
  const bookingEnd = useMemo(() => (waiver ? new Date(waiver.booking.end) : null), [waiver]);

  useEffect(() => {
    if (!submitAttempted || canSubmit) return;

    window.requestAnimationFrame(() => {
      waiverCardRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    });
  }, [canSubmit, submitAttempted]);

  const loadWaiver = useCallback(async () => {
    const response = await fetch(appPath(`/api/waivers/${bookingId}?token=${encodeURIComponent(token)}`), {
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(await readApiError(response));
    }

    const json = (await response.json()) as { waiver: WaiverContext };
    setWaiver(json.waiver);
  }, [bookingId, token]);

  useEffect(() => {
    startTransition(async () => {
      try {
        await loadWaiver();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Impossibile caricare il modulo.";
        setNotice({
          type: "error",
          text: friendlyLoadError(message),
        });
      }
    });
  }, [loadWaiver]);

  async function submitSignature() {
    setNotice(null);

    if (!canSubmit) {
      if (!canContinueGuest) {
        setGuestStep(1);
        setIdentityStepAttempted(true);
      }
      setSubmitAttempted(true);
      setNotice({ type: "warning", text: "Completa tutti i campi obbligatori prima di firmare." });
      return;
    }

    const response = await fetch(appPath(`/api/waivers/${bookingId}/sign`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        signerName: normalizedSignerName,
        signerEmail: normalizedSignerEmail,
        birthDate: birthDateIso,
        birthPlace: waiverForm.birthPlace,
        isAdultConfirmed: waiverForm.isAdultConfirmed,
        privacyAccepted: waiverForm.privacyAccepted,
        regulationAccepted: waiverForm.regulationAccepted,
        liabilityAccepted: waiverForm.liabilityAccepted,
        specificApprovalAccepted: waiverForm.specificApprovalAccepted,
        signatureImageDataUrl: waiverForm.signatureImageDataUrl,
      }),
    });

    if (!response.ok) {
      setNotice({ type: "error", text: await readApiError(response) });
      return;
    }

    const json = (await response.json()) as { waiver: WaiverContext };
    setWaiver(json.waiver);
    setNotice(null);
    setHasSigned(true);
    setSignerName("");
    setSignerEmail("");
    setWaiverForm(emptyWaiverForm);
    setGuestStep(1);
    setTouchedFields({});
    setIdentityStepAttempted(false);
    setSubmitAttempted(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function focusFirstInvalidField() {
    window.requestAnimationFrame(() => {
      waiverCardRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    });
  }

  function continueToWaiverStep() {
    setNotice(null);
    setIdentityStepAttempted(true);

    if (!canContinueGuest) {
      setNotice({ type: "warning", text: "Completa i tuoi dati per continuare." });
      focusFirstInvalidField();
      return;
    }

    setSignerName(normalizedSignerName);
    setSignerEmail(normalizedSignerEmail);
    setGuestStep(2);
    window.requestAnimationFrame(() => {
      waiverCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  const isIdentityField = (field: GuestField) => field === "signerName" || field === "signerEmail";
  const showFieldError = (field: GuestField, invalid: boolean) =>
    invalid && (submitAttempted || Boolean(touchedFields[field]) || (identityStepAttempted && isIdentityField(field)));
  const markTouched = (field: GuestField) => {
    setTouchedFields((current) => ({ ...current, [field]: true }));
  };

  return (
    <main className="app-shell compact-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <Image src={appPath("/topfly-logo.png")} alt="TOPFLY GPS solutions" width={678} height={147} priority />
          <div>
            <p className="muted-label">Padel aziendale</p>
            <h1>Firma accesso campo</h1>
          </div>
        </div>
      </header>

      <section className="summary-card waiver-page-card" ref={waiverCardRef}>
        {notice ? (
          <div
            aria-live={notice.type === "error" ? "assertive" : "polite"}
            className={`notice ${notice.type}`}
            role={notice.type === "error" ? "alert" : "status"}
          >
            {notice.text}
          </div>
        ) : null}

        {waiver && bookingStart && bookingEnd ? (
          <>
            <div className="guest-brief">
              <span className="summary-state-icon success" aria-hidden="true">
                <Check size={17} />
              </span>
              <div className="guest-brief-copy">
                <p className="muted-label">Accesso campo</p>
                <h2>Firma accesso campo</h2>
                <p>
                  {localDateTime(bookingStart)} - {localTime(bookingEnd)}
                </p>
                <small>Referente: {waiver.booking.organizerName}</small>
              </div>
              <span className="count-pill">
                {waiver.booking.waiverSignedCount}/{waiver.booking.playerCount} firme
              </span>
            </div>

            {hasSigned ? (
              <div className="guest-success-card">
                <strong>Firma registrata.</strong>
                <p>
                  Il PDF firmato è stato inviato alla Direzione. Riceverai una mail con riepilogo,
                  evento calendario e link per rinunciare al posto se non puoi esserci.
                </p>
              </div>
            ) : waiver.booking.remainingSignatures <= 0 ? (
              <div className="notice success">
                <Check size={17} />
                <div>
                  <strong>Posti completi.</strong>
                  <span>Tutte le firme per questa prenotazione risultano raccolte.</span>
                </div>
              </div>
            ) : (
              <div className="guest-sign-flow">
                <div className="checkout-stepper" aria-label="Avanzamento firma ospite">
                  <button
                    aria-current={guestStep === 1 ? "step" : undefined}
                    className={guestStep === 1 ? "active" : "done"}
                    onClick={() => {
                      setGuestStep(1);
                      setNotice(null);
                    }}
                    type="button"
                  >
                    <span>1</span>
                    I tuoi dati
                  </button>
                  <button
                    aria-current={guestStep === 2 ? "step" : undefined}
                    className={guestStep === 2 ? "active" : ""}
                    onClick={continueToWaiverStep}
                    type="button"
                  >
                    <span>2</span>
                    Scarico e firma
                  </button>
                </div>

                {guestStep === 1 ? (
                  <section className="guest-section">
                    <div className="guest-field-grid">
                      <label>
                        Nome e cognome
                        <input
                          autoComplete="name"
                          required
                          aria-invalid={showFieldError("signerName", normalizedSignerName.length < 2) || undefined}
                          value={signerName}
                          onBlur={() => markTouched("signerName")}
                          onChange={(event) => setSignerName(event.target.value)}
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
                          aria-invalid={showFieldError("signerEmail", !isValidEmail(normalizedSignerEmail)) || undefined}
                          value={signerEmail}
                          onBlur={() => {
                            markTouched("signerEmail");
                            setSignerEmail(normalizedSignerEmail);
                          }}
                          onChange={(event) => setSignerEmail(event.target.value)}
                          placeholder="nome@topflysolutions.com"
                        />
                      </label>
                    </div>
                    <div className="checkout-step-actions">
                      <button className="primary-button full-width" onClick={continueToWaiverStep} type="button">
                        Continua
                      </button>
                    </div>
                  </section>
                ) : (
                  <section className="guest-section checkout-submit-panel">
                    <WaiverFormSection
                      birthDateIsValid={Boolean(birthDateIso)}
                      compact
                      helperText="Modulo e regolamento saranno allegati al PDF firmato."
                      layout="checkout"
                      regulationUrl={appPath(waiver.booking.regulationUrl)}
                      templateUrl={appPath("/legal/modulo-responsabilita-padel-template-v1.pdf")}
                      showErrors={submitAttempted}
                      signerName={normalizedSignerName}
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
                          setGuestStep(1);
                          setNotice(null);
                        }}
                        type="button"
                      >
                        Indietro
                      </button>
                      <button
                        className="primary-button full-width"
                        disabled={isPending}
                        onClick={submitSignature}
                        type="button"
                      >
                        <Check size={18} />
                        Firma accesso campo
                      </button>
                    </div>
                  </section>
                )}
              </div>
            )}
          </>
        ) : !notice ? (
          <div className="notice info">
            <MailWarning size={17} />
            <span>Carico il modulo firma.</span>
          </div>
        ) : null}
      </section>
    </main>
  );
}
