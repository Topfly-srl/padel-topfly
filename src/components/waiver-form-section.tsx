"use client";

import { FileCheck2, FileText, Shield } from "lucide-react";
import { formatBirthDateInput } from "@/lib/birth-date-input";
import { SignaturePad } from "@/components/signature-pad";

export type WaiverFormValue = {
  birthDate: string;
  birthPlace: string;
  isAdultConfirmed: boolean;
  privacyAccepted: boolean;
  regulationAccepted: boolean;
  liabilityAccepted: boolean;
  specificApprovalAccepted: boolean;
  signatureImageDataUrl: string;
};

export type WaiverField =
  | "birthDate"
  | "birthPlace"
  | "isAdultConfirmed"
  | "privacyAccepted"
  | "regulationAccepted"
  | "liabilityAccepted"
  | "specificApprovalAccepted"
  | "signatureImageDataUrl";

type WaiverFormSectionProps = {
  value: WaiverFormValue;
  signerName: string;
  birthDateIsValid: boolean;
  regulationUrl: string;
  templateUrl?: string;
  helperText: string;
  compact?: boolean;
  layout?: "default" | "checkout";
  showErrors?: boolean;
  touched?: Partial<Record<WaiverField, boolean>>;
  onTouched?: (field: WaiverField) => void;
  onChange: (next: WaiverFormValue) => void;
};

const consentRows: Array<{
  field: Exclude<
    WaiverField,
    "birthDate" | "birthPlace" | "signatureImageDataUrl"
  >;
  title: string;
  shortTitle: string;
  copy: string;
}> = [
  {
    field: "isAdultConfirmed",
    title: "Confermo di essere maggiorenne",
    shortTitle: "Sono maggiorenne",
    copy: "Per minori serve autorizzazione della Direzione.",
  },
  {
    field: "privacyAccepted",
    title: "Ho preso visione della privacy",
    shortTitle: "Ho letto la privacy",
    copy: "Ho ricevuto o potuto leggere l'informativa applicabile.",
  },
  {
    field: "regulationAccepted",
    title: "Ho letto e accetto il regolamento",
    shortTitle: "Accetto il regolamento",
    copy: "Ho letto, compreso e accetto il regolamento.",
  },
  {
    field: "liabilityAccepted",
    title: "Accetto responsabilità e manleva",
    shortTitle: "Accetto responsabilità e manleva",
    copy: "Accetto nei limiti previsti dalla legge.",
  },
  {
    field: "specificApprovalAccepted",
    title: "Approvo le clausole specifiche del modulo",
    shortTitle: "Approvo le clausole del modulo",
    copy: "Approvo le clausole indicate nel modulo.",
  },
];

export function WaiverFormSection({
  value,
  signerName,
  birthDateIsValid,
  regulationUrl,
  templateUrl,
  helperText,
  compact = false,
  layout = "default",
  showErrors = false,
  touched = {},
  onTouched,
  onChange,
}: WaiverFormSectionProps) {
  const isCheckout = layout === "checkout";
  const fieldInvalid = (field: WaiverField, invalid: boolean) =>
    invalid && (showErrors || Boolean(touched[field]));

  const update = (next: Partial<WaiverFormValue>) => {
    onChange({ ...value, ...next });
  };

  if (isCheckout) {
    return (
      <div className="waiver-box checkout-waiver-box">
        <div className="checkout-waiver-group">
          <div className="checkout-mini-title">
            <strong>Dati personali</strong>
            <small>Servono per compilare il PDF automaticamente.</small>
          </div>
          <div className="selector-row compact">
            <label>
              Data di nascita
              <input
                autoComplete="bday"
                inputMode="numeric"
                maxLength={10}
                pattern="\d{2}/\d{2}/\d{4}"
                placeholder="gg/mm/aaaa"
                required
                type="text"
                aria-invalid={fieldInvalid("birthDate", !birthDateIsValid) || undefined}
                value={value.birthDate}
                onBlur={() => onTouched?.("birthDate")}
                onChange={(event) => update({ birthDate: formatBirthDateInput(event.target.value) })}
              />
            </label>
            <label>
              Luogo di nascita
              <input
                required
                aria-invalid={fieldInvalid("birthPlace", value.birthPlace.trim().length < 2) || undefined}
                value={value.birthPlace}
                onBlur={() => onTouched?.("birthPlace")}
                onChange={(event) => update({ birthPlace: event.target.value })}
                placeholder="Pretoro"
              />
            </label>
          </div>
        </div>

        <div className="checkout-waiver-group">
          <div className="checkout-mini-title">
            <strong>Documenti</strong>
            <small>{helperText}</small>
          </div>
          <div className="document-stack checkout-documents" aria-label="Documenti ufficiali">
            {templateUrl ? (
              <a className="document-link" href={templateUrl} rel="noreferrer" target="_blank">
                <FileText size={17} />
                <span>
                  Modulo PDF
                  <small>Apri modulo ufficiale</small>
                </span>
              </a>
            ) : null}
            <a className="document-link secondary" href={regulationUrl} rel="noreferrer" target="_blank">
              <Shield size={17} />
              <span>
                Regolamento
                <small>Apri regolamento</small>
              </span>
            </a>
          </div>
        </div>

        <div className="checkout-waiver-group">
          <div className="checkout-mini-title">
            <strong>Conferme</strong>
            <small>Spunta le dichiarazioni richieste.</small>
          </div>
          <div className="waiver-checklist checkout-checklist" aria-label="Consensi obbligatori">
            {consentRows.map((row) => (
              <label className="check-row" key={row.field}>
                <input
                  checked={value[row.field]}
                  onBlur={() => onTouched?.(row.field)}
                  onChange={(event) => {
                    onTouched?.(row.field);
                    update({ [row.field]: event.target.checked });
                  }}
                  type="checkbox"
                />
                <span>
                  <strong>{row.shortTitle}</strong>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="checkout-waiver-group">
          <SignaturePad
            showError={fieldInvalid("signatureImageDataUrl", !value.signatureImageDataUrl)}
            value={value.signatureImageDataUrl}
            onChange={(signatureImageDataUrl) => update({ signatureImageDataUrl })}
            onTouched={() => onTouched?.("signatureImageDataUrl")}
          />
          <small className="field-hint">
            Firmatario: {signerName.trim() || "inserisci prima nome e cognome"}.
          </small>
        </div>
      </div>
    );
  }

  return (
    <div className={`waiver-box ${compact ? "compact-waiver" : ""}`}>
      <div className="selector-row compact">
        <label>
          Data di nascita
          <input
            autoComplete="bday"
            inputMode="numeric"
            maxLength={10}
            pattern="\d{2}/\d{2}/\d{4}"
            placeholder="gg/mm/aaaa"
            required
            type="text"
            aria-invalid={fieldInvalid("birthDate", !birthDateIsValid) || undefined}
            value={value.birthDate}
            onBlur={() => onTouched?.("birthDate")}
            onChange={(event) => update({ birthDate: formatBirthDateInput(event.target.value) })}
          />
        </label>
        <label>
          Luogo di nascita
          <input
            required
            aria-invalid={fieldInvalid("birthPlace", value.birthPlace.trim().length < 2) || undefined}
            value={value.birthPlace}
            onBlur={() => onTouched?.("birthPlace")}
            onChange={(event) => update({ birthPlace: event.target.value })}
            placeholder="Pretoro"
          />
        </label>
      </div>

      <div className="waiver-head">
        <span className="waiver-icon" aria-hidden="true">
          <FileCheck2 size={18} />
        </span>
        <div>
          <strong>PDF ufficiale TOPFLY</strong>
          <small>{helperText}</small>
        </div>
      </div>

      <div className="document-stack" aria-label="Documenti ufficiali">
        {templateUrl ? (
          <a className="document-link" href={templateUrl} rel="noreferrer" target="_blank">
            <FileText size={17} />
            <span>
              Modulo PDF ufficiale
              <small>Il PDF ufficiale compilato e inviato</small>
            </span>
          </a>
        ) : null}
        <a className="document-link secondary" href={regulationUrl} rel="noreferrer" target="_blank">
          <Shield size={17} />
          <span>
            Regolamento Padel
            <small>Apri PDF in nuova scheda</small>
          </span>
        </a>
      </div>

      <div className="waiver-checklist" aria-label="Consensi obbligatori">
        <div className="checklist-heading">
          Conferme obbligatorie
          <small>Spunta ogni dichiarazione per generare il PDF firmato.</small>
        </div>
        {consentRows.map((row) => (
          <label className="check-row" key={row.field}>
            <input
              checked={value[row.field]}
              onBlur={() => onTouched?.(row.field)}
              onChange={(event) => {
                onTouched?.(row.field);
                update({ [row.field]: event.target.checked });
              }}
              type="checkbox"
            />
            <span>
              <strong>{row.title}</strong>
              <small>{row.copy}</small>
            </span>
          </label>
        ))}
      </div>

      <SignaturePad
        showError={fieldInvalid("signatureImageDataUrl", !value.signatureImageDataUrl)}
        value={value.signatureImageDataUrl}
        onChange={(signatureImageDataUrl) => update({ signatureImageDataUrl })}
        onTouched={() => onTouched?.("signatureImageDataUrl")}
      />
      <small className="field-hint">
        Firmatario: {signerName.trim() || "inserisci prima nome e cognome"}.
      </small>
    </div>
  );
}
