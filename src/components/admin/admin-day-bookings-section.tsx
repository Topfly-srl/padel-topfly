"use client";

import { Edit3, Trash2 } from "lucide-react";
import { bookingStatusLabel, deadlineCopy } from "@/lib/booking-copy";
import { bookingStatusTone, localTime } from "@/lib/booking-ui";
import type { AvailabilityBooking } from "@/lib/types";

export function AdminDayBookingsSection({
  dayBookings,
  timeZone,
  onEditBooking,
  onCancelBooking,
}: {
  dayBookings: AvailabilityBooking[];
  // Fuso del campo: gli orari mostrati sono "di parete", non del dispositivo dell'admin.
  timeZone: string;
  onEditBooking: (booking: AvailabilityBooking) => void;
  onCancelBooking: (booking: AvailabilityBooking) => void;
}) {
  return (
    <details>
      <summary>Prenotazioni del giorno</summary>
      <div className="booking-list">
        {dayBookings.map((booking) => (
          <article className="booking-item" key={booking.id}>
            <div>
              <strong>{booking.organizerName}</strong>
              <span>
                {localTime(new Date(booking.start), timeZone)} - {localTime(new Date(booking.end), timeZone)}
              </span>
              <small>
                <span className={`status-badge ${bookingStatusTone(booking.status)}`}>
                  {bookingStatusLabel(booking.status)}
                </span>{" "}
                Firme scarico: {booking.waiverSignedCount}/{booking.playerCount}
                {booking.waiverEmailStatus === "FAILED" ? " · email PDF da reinviare" : ""}
              </small>
              {booking.status === "PENDING_SIGNATURES" ? (
                <small className="sync-warning-text">
                  Non usare il campo · {deadlineCopy(booking.signatureDeadlineAt, timeZone)}
                </small>
              ) : (
                <small className="copy-state success">Campo utilizzabile</small>
              )}
            </div>
            <div className="item-actions">
              <button
                className="mini-button"
                onClick={() => onEditBooking(booking)}
                type="button"
                aria-label={`Modifica prenotazione di ${booking.organizerName}`}
                title="Modifica prenotazione"
              >
                <Edit3 size={15} />
              </button>
              <button
                className="mini-button danger"
                onClick={() => onCancelBooking(booking)}
                type="button"
                aria-label={`Cancella prenotazione di ${booking.organizerName}`}
                title="Cancella prenotazione"
              >
                <Trash2 size={15} />
              </button>
            </div>
          </article>
        ))}
      </div>
    </details>
  );
}
