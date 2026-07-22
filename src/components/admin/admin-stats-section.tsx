"use client";

import { bookingStatusLabel } from "@/lib/booking-copy";
import { dateTimeFromParts, pad } from "@/lib/booking-ui";
import type { AdminStats } from "@/lib/types";

function statsWeekLabel(weekStart: string, timeZone: string) {
  return new Intl.DateTimeFormat("it-IT", { day: "2-digit", month: "short", timeZone }).format(
    dateTimeFromParts(weekStart, "00:00", timeZone),
  );
}

export function AdminStatsSection({
  stats,
  isStatsLoading,
  timeZone,
}: {
  stats: AdminStats | null;
  isStatsLoading: boolean;
  // Fuso del campo: le settimane delle statistiche sono chiavi "di parete" calcolate dal server.
  timeZone: string;
}) {
  return (
    <details>
      <summary>
        Statistiche {isStatsLoading ? <span className="loading-pill">Aggiorno</span> : null}
      </summary>
      {stats ? (
        <div className="stats-grid">
          <div className="stat-block">
            <span className="stat-heading">Totale prenotazioni</span>
            <strong className="stat-total">{stats.totalBookings}</strong>
          </div>

          <div className="stat-block">
            <span className="stat-heading">Per stato</span>
            {stats.byStatus.map((entry) => (
              <div className="stat-line" key={entry.status}>
                <span>{bookingStatusLabel(entry.status)}</span>
                <strong>{entry.count}</strong>
              </div>
            ))}
          </div>

          <div className="stat-block">
            <span className="stat-heading">Ultime 8 settimane</span>
            {stats.perWeek.map((entry) => (
              <div className="stat-line" key={entry.weekStart}>
                <span>Sett. {statsWeekLabel(entry.weekStart, timeZone)}</span>
                <strong>{entry.count}</strong>
              </div>
            ))}
          </div>

          <div className="stat-block">
            <span className="stat-heading">Per fascia oraria</span>
            {stats.perStartHour.length ? (
              stats.perStartHour.map((entry) => (
                <div className="stat-line" key={entry.hour}>
                  <span>{pad(entry.hour)}:00</span>
                  <strong>{entry.count}</strong>
                </div>
              ))
            ) : (
              <p className="empty-state">Nessuna prenotazione registrata.</p>
            )}
          </div>

          <div className="stat-block">
            <span className="stat-heading">Annullamenti</span>
            <div className="stat-line">
              <span>Automatici (firme mancanti)</span>
              <strong>
                {stats.cancellations.auto} · {stats.cancellations.autoPercent}%
              </strong>
            </div>
            <div className="stat-line">
              <span>Manuali</span>
              <strong>
                {stats.cancellations.manual} · {stats.cancellations.manualPercent}%
              </strong>
            </div>
            {stats.cancellations.reasons.map((entry) => (
              <div className="stat-line stat-line-sub" key={entry.reason}>
                <span>{entry.reason}</span>
                <strong>{entry.count}</strong>
              </div>
            ))}
            {stats.cancellations.manualWithoutReason ? (
              <div className="stat-line stat-line-sub">
                <span>Senza causale</span>
                <strong>{stats.cancellations.manualWithoutReason}</strong>
              </div>
            ) : null}
          </div>
        </div>
      ) : isStatsLoading ? null : (
        <p className="empty-state">Statistiche non disponibili.</p>
      )}
    </details>
  );
}
