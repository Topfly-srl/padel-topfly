"use client";

import { Copy } from "lucide-react";
import { useMemo, useSyncExternalStore } from "react";
import { buildShortGuestWaiverLink } from "@/lib/guest-waiver-link";

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

export function GuestLinkPanel({
  link,
  copied = false,
  onCopy,
}: GuestLinkPanelProps) {
  const origin = useSyncExternalStore(subscribeToOrigin, getClientOrigin, getServerOrigin);
  const shareLink = useMemo(() => buildShortGuestWaiverLink(link, origin), [link, origin]);

  return (
    <div className="guest-share-card compact">
      <div className="guest-share-actions">
        <button className="ghost-button full-width" onClick={() => onCopy(shareLink)} type="button">
          <Copy size={16} />
          {copied ? "Copiato" : "Copia link"}
        </button>
        <a className="ghost-button full-width" href={shareLink}>
          Apri pagina firma ospiti
        </a>
      </div>
      <input
        aria-label="Link firma ospiti"
        onFocus={(event) => event.currentTarget.select()}
        readOnly
        value={shareLink}
      />
      <small className={copied ? "copy-state success" : "copy-state"}>
        {copied ? "Link copiato negli appunti." : "Se serve, puoi copiarlo manualmente dal campo sopra."}
      </small>
    </div>
  );
}
