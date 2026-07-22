"use client";

import { Download, RotateCcw } from "lucide-react";
import { appPath } from "@/lib/app-path";
import { localDay, localTime } from "@/lib/booking-ui";
import { retriableWaiverEmailLegs, type WaiverMailLeg } from "@/lib/waiver-email";

export type AdminWaiverItem = {
  id: string;
  bookingId: string;
  bookingRevision: number;
  signerRole: "ORGANIZER" | "GUEST";
  signerName: string;
  signerEmail: string;
  signedAt: string;
  status: "ACTIVE" | "CANCELED";
  emailStatus: "PENDING" | "SENT" | "FAILED" | "SKIPPED";
  emailError: string | null;
  guestEmailStatus: "PENDING" | "SENT" | "FAILED" | "SKIPPED";
  guestEmailError: string | null;
  signerEmailStatus: "PENDING" | "SENT" | "FAILED" | "SKIPPED";
  signerEmailError: string | null;
  bookingStart: string;
  bookingEnd: string;
  playerCount: number;
};

function waiverEmailStatusLabel(status: AdminWaiverItem["emailStatus"]) {
  if (status === "SENT") return "Inviata";
  if (status === "FAILED") return "Da reinviare";
  if (status === "SKIPPED") return "Non configurata";
  return "In coda";
}

function waiverEmailStatusTone(status: AdminWaiverItem["emailStatus"]) {
  if (status === "SENT") return "success";
  if (status === "FAILED") return "danger";
  if (status === "SKIPPED") return "neutral";
  return "warning";
}

function waiverRetryLabel(legs: WaiverMailLeg[]) {
  if (legs.length > 1) return "Reinvia PDF Direzione e copia referente";
  return legs[0] === "signer" ? "Reinvia copia al referente" : "Reinvia PDF Direzione";
}

function waiverSignatureStatusLabel(status: AdminWaiverItem["status"]) {
  return status === "ACTIVE" ? "Attiva" : "Rinunciata";
}

function waiverSignatureStatusTone(status: AdminWaiverItem["status"]) {
  return status === "ACTIVE" ? "success" : "neutral";
}

export function AdminWaiversSection({
  adminWaivers,
  timeZone,
  adminWaiverStatusFilter,
  onStatusFilterChange,
  adminWaiverRoleFilter,
  onRoleFilterChange,
  adminWaiverQuery,
  onQueryChange,
  isAdminWaiversLoading,
  adminWaiverNextCursor,
  onLoadMore,
  onRetry,
}: {
  adminWaivers: AdminWaiverItem[];
  // Fuso del campo: gli orari delle prenotazioni firmate sono "di parete", non del dispositivo.
  timeZone: string;
  adminWaiverStatusFilter: AdminWaiverItem["emailStatus"] | "ALL";
  onStatusFilterChange: (value: AdminWaiverItem["emailStatus"] | "ALL") => void;
  adminWaiverRoleFilter: AdminWaiverItem["signerRole"] | "ALL";
  onRoleFilterChange: (value: AdminWaiverItem["signerRole"] | "ALL") => void;
  adminWaiverQuery: string;
  onQueryChange: (value: string) => void;
  isAdminWaiversLoading: boolean;
  adminWaiverNextCursor: string | null;
  onLoadMore: () => void;
  onRetry: (signatureId: string) => void;
}) {
  return (
    <details>
      <summary>
        Scarichi responsabilita {isAdminWaiversLoading ? <span className="loading-pill">Aggiorno</span> : null}
      </summary>
      <div className="admin-filter-row">
        <label>
          Stato email PDF
          <select
            value={adminWaiverStatusFilter}
            onChange={(event) => {
              onStatusFilterChange(event.target.value as AdminWaiverItem["emailStatus"] | "ALL");
            }}
          >
            <option value="ALL">Tutti</option>
            <option value="FAILED">Da reinviare</option>
            <option value="PENDING">In coda</option>
            <option value="SENT">Inviata</option>
            <option value="SKIPPED">Non configurata</option>
          </select>
        </label>
        <label>
          Ruolo
          <select
            value={adminWaiverRoleFilter}
            onChange={(event) =>
              onRoleFilterChange(event.target.value as AdminWaiverItem["signerRole"] | "ALL")
            }
          >
            <option value="ALL">Tutti</option>
            <option value="ORGANIZER">Referente</option>
            <option value="GUEST">Ospite</option>
          </select>
        </label>
        <label>
          Cerca
          <input
            value={adminWaiverQuery}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Nome o email"
          />
        </label>
        {isAdminWaiversLoading ? (
          <span className="loading-pill">Aggiorno</span>
        ) : (
          <span className="count-pill">{adminWaivers.length}</span>
        )}
      </div>
      <div className="booking-list">
        {adminWaivers.length ? (
          <>
            {adminWaivers.map((waiver) => {
              const retryLegs = retriableWaiverEmailLegs(waiver);

              return (
                <article className="booking-item" key={waiver.id}>
                  <div>
                    <strong>{waiver.signerName}</strong>
                    <span>
                      {waiver.signerRole === "ORGANIZER" ? "Referente" : "Ospite"} -{" "}
                      {localDay(new Date(waiver.bookingStart), timeZone)}, {localTime(new Date(waiver.bookingStart), timeZone)} -{" "}
                      {localTime(new Date(waiver.bookingEnd), timeZone)}
                    </span>
                    <small>
                      <span className={`status-badge ${waiverSignatureStatusTone(waiver.status)}`}>
                        Firma {waiverSignatureStatusLabel(waiver.status)}
                      </span>{" "}
                      <span className={`status-badge ${waiverEmailStatusTone(waiver.emailStatus)}`}>
                        PDF Direzione {waiverEmailStatusLabel(waiver.emailStatus)}
                      </span>{" "}
                      {waiver.signerRole === "ORGANIZER" ? (
                        <span className={`status-badge ${waiverEmailStatusTone(waiver.signerEmailStatus)}`}>
                          Copia referente {waiverEmailStatusLabel(waiver.signerEmailStatus)}
                        </span>
                      ) : (
                        <span className={`status-badge ${waiverEmailStatusTone(waiver.guestEmailStatus)}`}>
                          Email ospite {waiverEmailStatusLabel(waiver.guestEmailStatus)}
                        </span>
                      )}
                      {waiver.emailError ? ` - PDF: ${waiver.emailError.slice(0, 80)}` : ""}
                      {waiver.signerEmailError ? ` - Referente: ${waiver.signerEmailError.slice(0, 80)}` : ""}
                      {waiver.guestEmailError ? ` - Ospite: ${waiver.guestEmailError.slice(0, 80)}` : ""}
                    </small>
                  </div>
                  <div className="item-actions">
                    <a
                      className="mini-button"
                      href={appPath(`/api/admin/waivers/${waiver.id}/pdf`)}
                      aria-label={`Scarica PDF di ${waiver.signerName}`}
                      title="Scarica PDF"
                    >
                      <Download size={15} />
                    </a>
                    {retryLegs.length ? (
                      <button
                        className="mini-button"
                        onClick={() => onRetry(waiver.id)}
                        type="button"
                        aria-label={`${waiverRetryLabel(retryLegs)} di ${waiver.signerName}`}
                        title={waiverRetryLabel(retryLegs)}
                      >
                        <RotateCcw size={15} />
                      </button>
                    ) : null}
                  </div>
                </article>
              );
            })}
            {adminWaiverNextCursor ? (
              <button
                className="ghost-button full-width"
                disabled={isAdminWaiversLoading}
                onClick={onLoadMore}
                type="button"
              >
                Mostra altri
              </button>
            ) : null}
          </>
        ) : (
          <p className="empty-state">Nessuno scarico corrisponde al filtro selezionato.</p>
        )}
      </div>
    </details>
  );
}
