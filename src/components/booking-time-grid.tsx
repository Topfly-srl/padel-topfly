"use client";

import type { Ref } from "react";
import { timeSlotClassName, type TimelineSlot } from "@/lib/timeline-slots";
import type { AvailabilityBlock, AvailabilityBooking } from "@/lib/types";

// Griglia oraria condivisa (durata + slot) di booking-app e manage-booking. Prima ognuno la
// costruiva per conto proprio sopra bookingTimeOptions: stessa resa, due copie divergibili. Le
// differenze reali restano esplicite via prop:
// - manage esclude la propria prenotazione dai conflitti (gestito a monte in computeTimelineSlots) e
//   usa etichette/titoli diversi sugli slot occupati (busyLabel/busyTitle);
// - solo il calendario pubblico marca gli slot "attesa firme" (markPending) e mostra tutte le
//   durate ammesse dalle impostazioni, mentre manage e' compatto e parte dalle durate di default;
// - entrambi tracciano lo slot selezionato per lo scroll automatico (trackSelected + timelineRef):
//   con la griglia a giornata piena l'orario scelto puo' stare molto in basso.
export function BookingTimeGrid({
  durationOptions,
  duration,
  onDurationChange,
  slots,
  onSelectTime,
  compact = false,
  timelineClassName = "timeline",
  timelineAriaLabel,
  timelineRef,
  markPending = false,
  trackSelected = false,
  busyLabel,
  busyTitle,
}: {
  durationOptions: readonly number[];
  duration: number;
  onDurationChange: (minutes: number) => void;
  slots: Array<TimelineSlot<AvailabilityBooking, AvailabilityBlock>>;
  onSelectTime: (option: string) => void;
  compact?: boolean;
  timelineClassName?: string;
  timelineAriaLabel: string;
  timelineRef?: Ref<HTMLDivElement>;
  markPending?: boolean;
  trackSelected?: boolean;
  busyLabel: (booking: AvailabilityBooking) => string;
  busyTitle: (booking: AvailabilityBooking) => string;
}) {
  return (
    <>
      <div className={`booking-controls${compact ? " compact-controls" : ""}`}>
        <div>
          <div className="control-heading">
            <span>Durata</span>
          </div>
          <div className="duration-row" role="group" aria-label="Durata prenotazione">
            {durationOptions.map((minutes) => (
              <button
                aria-pressed={duration === minutes}
                className={`duration-chip ${duration === minutes ? "active" : ""}`}
                key={minutes}
                onClick={() => onDurationChange(minutes)}
                type="button"
              >
                {minutes}m
              </button>
            ))}
          </div>
        </div>

        <div className="control-heading timeline-heading">
          <span>Orario di inizio</span>
        </div>
      </div>

      <div className={timelineClassName} role="group" aria-label={timelineAriaLabel} ref={timelineRef}>
        {slots.map(({ option, booking, block, isSelected, isSelectedStart }) => (
          <button
            aria-pressed={isSelectedStart}
            className={timeSlotClassName({
              busy: Boolean(booking),
              pending: markPending && booking?.status === "PENDING_SIGNATURES",
              blocked: Boolean(block),
              selectedStart: isSelectedStart,
              selectedRange: isSelected,
            })}
            data-selected={trackSelected && isSelected ? "true" : undefined}
            disabled={Boolean(booking || block)}
            key={option}
            onClick={() => onSelectTime(option)}
            title={booking ? busyTitle(booking) : block?.reason}
            type="button"
          >
            <span>{option}</span>
            {booking ? <small>{busyLabel(booking)}</small> : null}
            {block ? <small>{block.reason}</small> : null}
          </button>
        ))}
      </div>
    </>
  );
}
