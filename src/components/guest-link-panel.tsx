"use client";

import { Copy } from "lucide-react";
import { useMemo, useSyncExternalStore } from "react";

type GuestLinkPanelProps = {
  link: string;
  copied?: boolean;
  onCopy: (link: string) => void;
};

function subscribeToOrigin() {
  return () => {};
}

function getClientOrigin() {
  return window.location.origin;
}

function getServerOrigin() {
  return "";
}

function normalizeGuestWaiverLink(link: string, origin: string) {
  if (!origin) return link;

  try {
    const url = new URL(link, origin);
    if (url.pathname.startsWith("/waiver/")) {
      return `${origin}${url.pathname}${url.search}${url.hash}`;
    }
    return url.toString();
  } catch {
    return link;
  }
}

export function GuestLinkPanel({
  link,
  copied = false,
  onCopy,
}: GuestLinkPanelProps) {
  const origin = useSyncExternalStore(subscribeToOrigin, getClientOrigin, getServerOrigin);
  const usableLink = useMemo(() => normalizeGuestWaiverLink(link, origin), [link, origin]);

  return (
    <div className="guest-share-card">
      <div>
        <strong>Firma ospiti</strong>
        <small>
          Condividi questo link con chi gioca con te. Il link completo resta visibile qui sotto.
        </small>
      </div>
      <div className="guest-share-actions">
        <button className="ghost-button full-width" onClick={() => onCopy(usableLink)} type="button">
          <Copy size={16} />
          {copied ? "Copiato" : "Copia link"}
        </button>
        <a className="ghost-button full-width" href={usableLink}>
          Apri firma ospiti
        </a>
      </div>
      <input
        aria-label="Link firma ospiti"
        onFocus={(event) => event.currentTarget.select()}
        readOnly
        value={usableLink}
      />
      <small className={copied ? "copy-state success" : "copy-state"}>
        {copied ? "Link copiato negli appunti." : "Se il copia non funziona, seleziona il testo e copialo manualmente."}
      </small>
    </div>
  );
}
