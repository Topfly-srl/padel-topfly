"use client";

import { Copy } from "lucide-react";
import { useMemo, useSyncExternalStore } from "react";
import { buildShortGuestWaiverLink } from "@/lib/guest-waiver-link";

type GuestLinkPanelProps = {
  link: string;
  copied?: boolean;
  copyLabel?: string;
  openLabel?: string;
  onCopy: (link: string) => void;
  showLinkInput?: boolean;
  tone?: "default" | "pending";
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
  copyLabel = "Copia link",
  openLabel = "Apri pagina firma ospiti",
  onCopy,
  showLinkInput = true,
  tone = "default",
}: GuestLinkPanelProps) {
  const origin = useSyncExternalStore(subscribeToOrigin, getClientOrigin, getServerOrigin);
  const shareLink = useMemo(() => buildShortGuestWaiverLink(link, origin), [link, origin]);

  return (
    <div className={`guest-share-card compact ${showLinkInput ? "" : "actions-only"} ${tone}`}>
      <div className="guest-share-actions">
        <button
          className="ghost-button full-width"
          onClick={() => onCopy(shareLink)}
          type="button"
        >
          <Copy size={16} />
          {copied ? "Copiato" : copyLabel}
        </button>
        <a className={`${tone === "pending" ? "primary-button" : "ghost-button"} full-width`} href={shareLink}>
          {openLabel}
        </a>
      </div>
      {showLinkInput ? (
        <>
          <input
            aria-label="Link firma ospiti"
            onFocus={(event) => event.currentTarget.select()}
            readOnly
            value={shareLink}
          />
          <small className={copied ? "copy-state success" : "copy-state"}>
            {copied ? "Link copiato negli appunti." : "Se serve, puoi copiarlo manualmente dal campo sopra."}
          </small>
        </>
      ) : copied ? (
        <small className="copy-state success">Link copiato negli appunti.</small>
      ) : null}
    </div>
  );
}
