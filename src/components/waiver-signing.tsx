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
  environmentLabel = "",
  token,
}: {
  bookingId: string;
  environmentLabel?: string;
  token: string;
}) {
  const [waiver, setWaiver] = useState<WaiverContext | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [signerName, setSignerName] = useState("");
  const [signerEmail, setSignerEmail] = useState("");
  const [waiverForm, setWaiverForm] = useState<WaiverFormValue>(emptyWaiverForm);
  const [touchedFields, setTouchedFields] = useState<Partial<Record<GuestField, boolean>>>({});
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [hasSigned, setHasSigned] = useState(false);
  const [isPending, startTransition] = useTransition();
  const waiverCardRef = useRef<HTMLElement | null>(null);

  const birthDateIso = birthDateInputToIsoDate(waiverForm.birthDate);
  const normalizedSignerEmail = normalizeEmailInput(signerEmail);
  const canSubmit =
    !isPending &&
    waiver &&
    waiver.booking.remainingSignatures > 0 &&
    signerName.trim().length > 1 &&
    isValidEmail(normalizedSignerEmail) &&
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
    if (signerName.trim().length < 2) missing.push("nome e cognome");
    if (!isValidEmail(normalizedSignerEmail)) missing.push("email valida");
    if (!birthDateIso) missing.push("data di nascita");
    if (waiverForm.birthPlace.trim().length < 2) missing.push("luogo di nascita");
    if (!waiverForm.isAdultConfirmed) missing.push("maggiore età");
    if (!waiverForm.privacyAccepted) missing.push("privacy");
    if (!waiverForm.regulationAccepted) missing.push("regolamento");
    if (!waiverForm.liabilityAccepted) missing.push("responsabilità");
    if (!waiverForm.specificApprovalAccepted) missing.push("clausole specifiche");
    if (!waiverForm.signatureImageDataUrl) missing.push("firma nel riquadro");
    return missing;
  }, [
    birthDateIso,
    normalizedSignerEmail,
    signerName,
    waiverForm.birthPlace,
    waiverForm.isAdultConfirmed,
    waiverForm.liabilityAccepted,
    waiverForm.privacyAccepted,
    waiverForm.regulationAccepted,
    waiverForm.signatureImageDataUrl,
    waiverForm.specificApprovalAccepted,
  ]);

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
      setSubmitAttempted(true);
      setNotice({ type: "warning", text: "Completa tutti i campi obbligatori prima di firmare." });
      return;
    }

    const response = await fetch(appPath(`/api/waivers/${bookingId}/sign`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        signerName,
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
    setTouchedFields({});
    setSubmitAttempted(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const showFieldError = (field: GuestField, invalid: boolean) =>
    invalid && (submitAttempted || Boolean(touchedFields[field]));
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
            {environmentLabel ? <span className="environment-badge">{environmentLabel}</span> : null}
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
                <section className="guest-section">
                  <div className="guest-section-title">
                    <strong>I tuoi dati</strong>
                    <small>Servono per compilare il PDF automaticamente.</small>
                  </div>
                  <div className="guest-field-grid">
                    <label>
                      Nome e cognome
                      <input
                        autoComplete="name"
                        required
                        aria-invalid={showFieldError("signerName", signerName.trim().length < 2) || undefined}
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
                </section>

                <section className="guest-section">
                  <div className="guest-section-title">
                    <strong>Firma e consensi</strong>
                    <small>Dati, documenti, conferme e firma.</small>
                  </div>
                  <WaiverFormSection
                    birthDateIsValid={Boolean(birthDateIso)}
                    compact
                    helperText="Modulo e regolamento saranno allegati al PDF firmato."
                    regulationUrl={appPath(waiver.booking.regulationUrl)}
                    templateUrl={appPath("/legal/modulo-responsabilita-padel-template-v1.pdf")}
                    showErrors={submitAttempted}
                    signerName={signerName}
                    touched={touchedFields}
                    value={waiverForm}
                    onChange={setWaiverForm}
                    onTouched={markTouched}
                  />
                </section>

                <div className="guest-action-bar">
                  <small className={`form-submit-hint ${canSubmit ? "success" : ""}`}>
                    {canSubmit
                      ? "Tutto pronto: puoi firmare."
                      : `Completa: ${missingFields.slice(0, 3).join(", ")}${
                          missingFields.length > 3 ? "..." : ""
                        }`}
                  </small>
                  <button
                    className="primary-button full-width"
                    disabled={!canSubmit}
                    onClick={submitSignature}
                    type="button"
                  >
                    <Check size={18} />
                    Firma accesso campo
                  </button>
                </div>
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
