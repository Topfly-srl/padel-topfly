"use client";

import { Ban, Check, Loader2, Undo2, XCircle } from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { appPath } from "@/lib/app-path";

type CancelContext = {
  signature: {
    id: string;
    signerName: string;
    signerEmail: string;
    status: "ACTIVE" | "CANCELED";
    canceledAt: string | null;
  };
  booking: {
    id: string;
    start: string;
    end: string;
    organizerName: string;
    playerCount: number;
    waiverSignedCount: number;
    remainingSignatures: number;
    status: "CONFIRMED" | "CANCELED";
  };
};

type Notice = {
  type: "success" | "error" | "info" | "warning";
  text: string;
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

export function WaiverCancel({
  environmentLabel = "",
  signatureId,
  token,
}: {
  environmentLabel?: string;
  signatureId: string;
  token: string;
}) {
  const [cancelContext, setCancelContext] = useState<CancelContext | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [isPending, startTransition] = useTransition();

  const bookingStart = useMemo(
    () => (cancelContext ? new Date(cancelContext.booking.start) : null),
    [cancelContext],
  );
  const bookingEnd = useMemo(
    () => (cancelContext ? new Date(cancelContext.booking.end) : null),
    [cancelContext],
  );
  const isCanceled = cancelContext?.signature.status === "CANCELED";

  const loadContext = useCallback(async () => {
    const response = await fetch(
      appPath(`/api/waiver-signatures/${signatureId}/cancel?token=${encodeURIComponent(token)}`),
      { cache: "no-store" },
    );

    if (!response.ok) {
      throw new Error(await readApiError(response));
    }

    const json = (await response.json()) as { cancel: CancelContext };
    setCancelContext(json.cancel);
  }, [signatureId, token]);

  useEffect(() => {
    startTransition(async () => {
      try {
        await loadContext();
      } catch (error) {
        setNotice({
          type: "error",
          text: error instanceof Error ? error.message : "Impossibile caricare il link.",
        });
      }
    });
  }, [loadContext]);

  async function cancelSeat() {
    setNotice(null);
    const response = await fetch(appPath(`/api/waiver-signatures/${signatureId}/cancel`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });

    if (!response.ok) {
      setNotice({ type: "error", text: await readApiError(response) });
      return;
    }

    const json = (await response.json()) as { cancel: CancelContext };
    setCancelContext(json.cancel);
    setNotice({
      type: "success",
      text: "Posto liberato. La tua firma resta nello storico, ma non conta più tra i giocatori.",
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <main className="app-shell compact-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <Image src={appPath("/topfly-logo.png")} alt="TOPFLY GPS solutions" width={678} height={147} priority />
          <div>
            <p className="muted-label">Padel aziendale</p>
            <h1>Rinuncia posto</h1>
            {environmentLabel ? <span className="environment-badge">{environmentLabel}</span> : null}
          </div>
        </div>
      </header>

      <section className="summary-card waiver-page-card guest-cancel-card">
        {notice ? (
          <div
            aria-live={notice.type === "error" ? "assertive" : "polite"}
            className={`notice ${notice.type}`}
            role={notice.type === "error" ? "alert" : "status"}
          >
            {notice.text}
          </div>
        ) : null}

        {cancelContext && bookingStart && bookingEnd ? (
          <>
            <div className="guest-brief">
              <span className={`summary-state-icon ${isCanceled ? "danger" : "success"}`} aria-hidden="true">
                {isCanceled ? <Ban size={17} /> : <Check size={17} />}
              </span>
              <div className="guest-brief-copy">
                <p className="muted-label">Accesso campo</p>
                <h2>{isCanceled ? "Posto già liberato" : "Vuoi rinunciare al posto?"}</h2>
                <p>
                  {localDateTime(bookingStart)} - {localTime(bookingEnd)}
                </p>
                <small>Referente: {cancelContext.booking.organizerName}</small>
              </div>
              <span className="count-pill">
                {cancelContext.booking.waiverSignedCount}/{cancelContext.booking.playerCount} firme
              </span>
            </div>

            <div className="guest-cancel-details">
              <span>
                <small>Firmatario</small>
                <strong>{cancelContext.signature.signerName}</strong>
              </span>
              <span>
                <small>Email</small>
                <strong>{cancelContext.signature.signerEmail}</strong>
              </span>
            </div>

            {cancelContext.booking.status !== "CONFIRMED" ? (
              <div className="notice warning">
                <XCircle size={17} />
                <span>Questa prenotazione non è più attiva.</span>
              </div>
            ) : isCanceled ? (
              <div className="notice success">
                <Check size={17} />
                <span>Il posto risulta disponibile per un altro giocatore.</span>
              </div>
            ) : (
              <div className="guest-cancel-action">
                <p>
                  Se confermi, la tua firma non conterà più nel limite giocatori e un altro ospite potrà
                  firmare con il link condiviso dal referente.
                </p>
                <button className="danger-button full-width" disabled={isPending} onClick={cancelSeat} type="button">
                  <Undo2 size={18} />
                  Rinuncia al posto
                </button>
              </div>
            )}
          </>
        ) : !notice ? (
          <div className="notice info">
            <Loader2 size={17} />
            <span>Carico i dettagli della firma.</span>
          </div>
        ) : null}
      </section>
    </main>
  );
}
