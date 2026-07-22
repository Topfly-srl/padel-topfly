"use client";

import { Copy, Edit3, Trash2 } from "lucide-react";
import { bookingStatusLabel, deadlineCopy } from "@/lib/booking-copy";
import { bookingStatusTone, localDay, localTime, syncLabel } from "@/lib/booking-ui";
import type { MyBooking } from "@/lib/types";

// Estratto da booking-app.tsx: la sezione "Le mie prenotazioni" (lista, card, azioni). Il pannello
// pending resta separato (PendingSignaturePanel gia' condiviso). Nessun cambiamento di resa: stesse
// classi CSS e stessa struttura di prima, solo spostate in un componente dedicato.
export function MyBookingsSection({
  bookings,
  count,
  isLoading,
  timeZone,
  guestWaiverLinks,
  selectedBookingId,
  onCopyGuestLink,
  onEdit,
  onCancel,
}: {
  bookings: MyBooking[];
  count: number;
  isLoading: boolean;
  // Fuso del campo (da booking-app): gli orari mostrati sono "di parete", non del dispositivo.
  timeZone: string;
  guestWaiverLinks: Record<string, string>;
  selectedBookingId: string | null;
  onCopyGuestLink: (link: string) => void;
  onEdit: (booking: MyBooking) => void;
  onCancel: (booking: MyBooking) => void;
}) {
  return (
    <section className="panel">
      <div className="section-title spread">
        <span>Le mie prenotazioni</span>
        {isLoading ? (
          <span className="loading-pill">Aggiorno</span>
        ) : (
          <span className="count-pill">{count}</span>
        )}
      </div>
      <div className="booking-list">
        {bookings.length ? (
          bookings.map((booking) => {
            const guestLink = booking.guestWaiverUrl ?? guestWaiverLinks[booking.id];

            return (
              <article
                className={`booking-item compact ${booking.status.toLowerCase()} ${
                  selectedBookingId === booking.id ? "selected-booking" : ""
                }`}
                key={booking.id}
              >
                <div>
                  <strong>
                    {localDay(new Date(booking.start), timeZone)}, {localTime(new Date(booking.start), timeZone)} -{" "}
                    {localTime(new Date(booking.end), timeZone)}
                  </strong>
                  <small>
                    <span className={`status-badge ${bookingStatusTone(booking.status)}`}>
                      {bookingStatusLabel(booking.status)}
                    </span>
                    {syncLabel(booking.outlookSyncStatus, booking.status)
                      ? ` · ${syncLabel(booking.outlookSyncStatus, booking.status)}`
                      : ""}
                  </small>
                  <small>
                    Firme scarico: {booking.waiverSignedCount}/{booking.playerCount}
                  </small>
                  {booking.status === "PENDING_SIGNATURES" ? (
                    <small>{deadlineCopy(booking.signatureDeadlineAt, timeZone)}</small>
                  ) : null}
                </div>
                <div className="item-actions">
                  {guestLink ? (
                    <button
                      className="mini-button"
                      onClick={() => onCopyGuestLink(guestLink)}
                      type="button"
                      aria-label="Copia link firma ospiti"
                      title="Copia link firma ospiti"
                    >
                      <Copy size={15} />
                    </button>
                  ) : null}
                  <button
                    className="mini-button"
                    onClick={() => onEdit(booking)}
                    type="button"
                    aria-label="Modifica"
                    title="Modifica"
                  >
                    <Edit3 size={15} />
                  </button>
                  <button
                    className="mini-button danger"
                    onClick={() => onCancel(booking)}
                    type="button"
                    aria-label="Cancella"
                    title="Cancella"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </article>
            );
          })
        ) : (
          <p className="empty-state">Nessuna prenotazione attiva salvata su questo dispositivo.</p>
        )}
      </div>
    </section>
  );
}
