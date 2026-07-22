"use client";

import { auditActionLabel } from "@/lib/booking-copy";
import { localDateTime } from "@/lib/booking-ui";
import { auditActions, type AuditAction, type AuditItem } from "@/lib/types";

export function AdminAuditSection({
  audit,
  timeZone,
  auditActionFilter,
  onAuditActionFilterChange,
  isAuditLoading,
  auditNextCursor,
  onLoadMore,
}: {
  audit: AuditItem[];
  // Fuso del campo: anche i timestamp dello storico si leggono nell'ora di parete del campo.
  timeZone: string;
  auditActionFilter: AuditAction | "ALL";
  onAuditActionFilterChange: (value: AuditAction | "ALL") => void;
  isAuditLoading: boolean;
  auditNextCursor: string | null;
  onLoadMore: () => void;
}) {
  return (
    <details>
      <summary>Storico recente {isAuditLoading ? <span className="loading-pill">Aggiorno</span> : null}</summary>
      <div className="admin-filter-row">
        <label>
          Azione
          <select
            value={auditActionFilter}
            onChange={(event) => onAuditActionFilterChange(event.target.value as AuditAction | "ALL")}
          >
            <option value="ALL">Tutte</option>
            {auditActions.map((action) => (
              <option key={action} value={action}>
                {auditActionLabel(action)}
              </option>
            ))}
          </select>
        </label>
        {isAuditLoading ? (
          <span className="loading-pill">Aggiorno</span>
        ) : (
          <span className="count-pill">{audit.length}</span>
        )}
      </div>
      <div className="audit-list">
        {audit.length ? (
          <>
            {audit.map((item) => (
              <div className="audit-row" key={item.id}>
                <span>{auditActionLabel(item.action)}</span>
                <small>
                  {item.actorEmail} - {localDateTime(new Date(item.createdAt), timeZone)}
                </small>
                {item.cancelReason ? <small>Causale: {item.cancelReason}</small> : null}
              </div>
            ))}
            {auditNextCursor ? (
              <button
                className="ghost-button full-width"
                disabled={isAuditLoading}
                onClick={onLoadMore}
                type="button"
              >
                Mostra altri
              </button>
            ) : null}
          </>
        ) : isAuditLoading ? null : (
          <p className="empty-state">Nessuna attività recente registrata.</p>
        )}
      </div>
    </details>
  );
}
