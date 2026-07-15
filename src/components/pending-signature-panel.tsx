"use client";

import { AlertTriangle, Check, Clock3, FileText } from "lucide-react";
import { GuestLinkPanel } from "@/components/guest-link-panel";

type PendingSignatureFootnote = {
  success: boolean;
  text: string;
};

type PendingSignaturePanelProps = {
  missingSignatures: number;
  signatureDeadlineAt: string | null;
  guestWaiverLink: string | null;
  linkCopied: boolean;
  onCopyLink: (link: string) => void;
  footnote: PendingSignatureFootnote | null;
};

function localTime(date: Date) {
  return new Intl.DateTimeFormat("it-IT", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function localDeadlineDateTime(date: Date) {
  const day = new Intl.DateTimeFormat("it-IT", {
    weekday: "long",
    day: "2-digit",
    month: "long",
  }).format(date);

  return `${day} alle ${localTime(date)}`;
}

function missingSignatureTitle(count: number) {
  return count === 1 ? "Manca 1 firma" : `Mancano ${count} firme`;
}

export function PendingSignaturePanel({
  missingSignatures,
  signatureDeadlineAt,
  guestWaiverLink,
  linkCopied,
  onCopyLink,
  footnote,
}: PendingSignaturePanelProps) {
  return (
    <div className="pending-signature-panel">
      <div className="pending-signature-status">
        <div className="pending-signature-copy">
          <span className="pending-signature-eyebrow">
            <Clock3 size={15} />
            Non confermata
          </span>
          <strong>{missingSignatureTitle(missingSignatures)}</strong>
          <p className="pending-signature-deadline">
            {signatureDeadlineAt
              ? `Scadenza: ${localDeadlineDateTime(new Date(signatureDeadlineAt))}.`
              : "Scadenza: prima dell'orario di gioco."}
          </p>
        </div>
        <div className="pending-signature-cancel">
          <AlertTriangle size={17} />
          <strong>
            Se manca anche una sola firma alla scadenza, la prenotazione viene annullata automaticamente.
          </strong>
        </div>
      </div>
      <div className="pending-signature-action-block">
        {guestWaiverLink ? (
          <div className="pending-signature-share">
            <strong>Condividi il link con gli ospiti</strong>
            <GuestLinkPanel
              copied={linkCopied}
              copyLabel="Copia link"
              link={guestWaiverLink}
              onCopy={onCopyLink}
              openLabel="Apri firma ospiti"
              showLinkInput={false}
              tone="pending"
            />
          </div>
        ) : null}
        {footnote ? (
          <small className="pending-signature-footnote">
            {footnote.success ? <Check size={14} /> : <FileText size={14} />}
            {footnote.text}
          </small>
        ) : null}
      </div>
    </div>
  );
}
