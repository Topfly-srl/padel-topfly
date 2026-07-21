"use client";

import { Check, Clock3, Trash2 } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { appPath } from "@/lib/app-path";
import { CancelReasonSelect } from "@/components/cancel-reason-select";
import { resolveCancelReason, type CancelReasonMode } from "@/lib/cancel-reason";
import { bookingDurationOptions } from "@/lib/booking-constants";
import { bookingStatusLabel, deadlineCopy } from "@/lib/booking-copy";
import {
  dateTimeFromParts,
  localDateTime,
  pad,
  readApiError,
  type Notice,
} from "@/lib/booking-ui";
import {
  bookingTimeOptions,
  computeTimelineSlots,
  type TimelineRange,
} from "@/lib/timeline-slots";
import type { AvailabilityBlock, AvailabilityBooking, MyBooking } from "@/lib/types";
import { BookingTimeGrid } from "@/components/booking-time-grid";

type AvailabilityResponse = {
  bookings: AvailabilityBooking[];
  blocks: AvailabilityBlock[];
};

const tokenStorageKey = "topfly-padel.tokens.v1";
// La griglia oraria copre sempre l'intera giornata: e' una costante, non dipende da impostazioni.
const options = bookingTimeOptions();

function dateKey(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60_000);
}

function rangeOverlaps(start: Date, end: Date, itemStart: string, itemEnd: string) {
  const rightStart = new Date(itemStart);
  const rightEnd = new Date(itemEnd);
  return start < rightEnd && end > rightStart;
}

function minutesBetween(start: Date, end: Date) {
  return Math.round((end.getTime() - start.getTime()) / 60_000);
}

function cancellationSuccessText(status: string) {
  if (status === "SYNCED") return "Prenotazione annullata. Cancellazione Outlook inviata.";
  if (status === "FAILED") return "Prenotazione annullata. Cancellazione Outlook non riuscita.";
  return "Prenotazione annullata.";
}

function isActiveBooking(booking: Pick<MyBooking, "status">) {
  return booking.status === "CONFIRMED" || booking.status === "PENDING_SIGNATURES";
}

function rememberToken(token: string) {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(tokenStorageKey) ?? "[]") as unknown;
    const tokens = Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
    window.localStorage.setItem(
      tokenStorageKey,
      JSON.stringify([token, ...tokens.filter((item) => item !== token)].slice(0, 30)),
    );
  } catch {
    window.localStorage.setItem(tokenStorageKey, JSON.stringify([token]));
  }
}

export function ManageBooking({
  bookingId,
  manageToken,
}: {
  bookingId: string;
  manageToken: string;
}) {
  const [booking, setBooking] = useState<MyBooking | null>(null);
  const [availability, setAvailability] = useState<AvailabilityResponse | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selectedDate, setSelectedDate] = useState(dateKey(new Date()));
  const [selectedTime, setSelectedTime] = useState("18:00");
  const [duration, setDuration] = useState(60);
  const [isSaving, setIsSaving] = useState(false);
  const [isCanceling, setIsCanceling] = useState(false);
  const [cancelReasonMode, setCancelReasonMode] = useState<CancelReasonMode>("");
  const [cancelReasonText, setCancelReasonText] = useState("");
  const [isPending, startTransition] = useTransition();
  const start = useMemo(
    () => dateTimeFromParts(selectedDate, selectedTime),
    [selectedDate, selectedTime],
  );
  const end = useMemo(() => addMinutes(start, duration), [duration, start]);
  const selectionConflict = useMemo(() => {
    if (!availability || !booking || !isActiveBooking(booking)) return null;

    const conflictingBooking = availability.bookings.find(
      (item) => item.id !== booking.id && rangeOverlaps(start, end, item.start, item.end),
    );
    if (conflictingBooking) return `Occupato da ${conflictingBooking.organizerName}`;

    const conflictingBlock = availability.blocks.find((item) => rangeOverlaps(start, end, item.start, item.end));
    if (conflictingBlock) return `Bloccato: ${conflictingBlock.reason}`;

    return null;
  }, [availability, booking, end, start]);

  const startMs = start.getTime();
  const endMs = end.getTime();
  const bookingRanges = useMemo<Array<TimelineRange<AvailabilityBooking>>>(
    () =>
      (availability?.bookings ?? []).map((item) => ({
        item,
        startMs: new Date(item.start).getTime(),
        endMs: new Date(item.end).getTime(),
      })),
    [availability?.bookings],
  );
  const blockRanges = useMemo<Array<TimelineRange<AvailabilityBlock>>>(
    () =>
      (availability?.blocks ?? []).map((item) => ({
        item,
        startMs: new Date(item.start).getTime(),
        endMs: new Date(item.end).getTime(),
      })),
    [availability?.blocks],
  );
  // Stessa griglia del calendario pubblico, ma escludendo la propria prenotazione dai conflitti
  // (ignoreBookingId): modificando i propri orari lo slot occupato da me non deve risultare occupato.
  const timelineSlots = useMemo(
    () =>
      computeTimelineSlots({
        options,
        selectedDate,
        selectedTime,
        startMs,
        endMs,
        bookingRanges,
        blockRanges,
        ignoreBookingId: booking?.id,
      }),
    [selectedDate, selectedTime, startMs, endMs, bookingRanges, blockRanges, booking?.id],
  );

  // Con la griglia a giornata piena (96 slot da 00:00) l'orario della prenotazione puo' stare
  // molto in basso: stesso auto-scroll del calendario pubblico, centrato sullo slot selezionato.
  const timelineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timeline = timelineRef.current;
    const selected = timeline?.querySelector<HTMLElement>("[data-selected='true']");

    if (!timeline || !selected) return;

    timeline.scrollTop = Math.max(
      0,
      selected.offsetTop - timeline.offsetTop - timeline.clientHeight / 2 + selected.clientHeight / 2,
    );
  }, [timelineSlots]);

  useEffect(() => {
    startTransition(async () => {
      const response = await fetch(appPath("/api/bookings/lookup"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokens: [manageToken] }),
      });

      if (!response.ok) {
        setNotice({ type: "error", text: await readApiError(response) });
        return;
      }

      const json = (await response.json()) as { bookings: MyBooking[] };
      const found = json.bookings.find((item) => item.id === bookingId) ?? null;

      if (!found) {
        setNotice({ type: "error", text: "Link non valido, scaduto o prenotazione non trovata." });
        return;
      }

      const bookingStart = new Date(found.start);
      const bookingEnd = new Date(found.end);
      setBooking(found);
      setSelectedDate(dateKey(bookingStart));
      setSelectedTime(`${pad(bookingStart.getHours())}:${pad(bookingStart.getMinutes())}`);
      setDuration(minutesBetween(bookingStart, bookingEnd));
      rememberToken(manageToken);
    });
  }, [bookingId, manageToken]);

  useEffect(() => {
    if (!booking || !isActiveBooking(booking)) return;

    let canceled = false;

    startTransition(async () => {
      const response = await fetch(appPath(`/api/availability?date=${selectedDate}`), { cache: "no-store" });
      if (!response.ok || canceled) return;
      setAvailability((await response.json()) as AvailabilityResponse);
    });

    return () => {
      canceled = true;
    };
  }, [booking, selectedDate]);

  async function updateBooking() {
    if (isSaving || isCanceling) return;

    setNotice(null);

    if (selectionConflict) {
      setNotice({ type: "error", text: selectionConflict });
      return;
    }

    setIsSaving(true);

    try {
      const response = await fetch(appPath(`/api/bookings/${bookingId}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start: start.toISOString(),
          end: end.toISOString(),
          manageToken,
        }),
      });

      if (!response.ok) {
        setNotice({ type: "error", text: await readApiError(response) });
        return;
      }

      const json = (await response.json()) as { booking: MyBooking };
      setBooking(json.booking);
      setNotice({
        type: json.booking.status === "PENDING_SIGNATURES" ? "warning" : "success",
        text:
          json.booking.status === "PENDING_SIGNATURES"
            ? "Prenotazione aggiornata e rimessa in attesa firme."
            : "Prenotazione aggiornata.",
      });
    } finally {
      setIsSaving(false);
    }
  }

  async function cancelBooking() {
    if (isSaving || isCanceling) return;

    if (!window.confirm("Vuoi cancellare questa prenotazione?")) {
      return;
    }

    setNotice(null);
    setIsCanceling(true);

    const cancelReason = resolveCancelReason(cancelReasonMode, cancelReasonText);

    try {
      const response = await fetch(appPath(`/api/bookings/${bookingId}`), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manageToken, ...(cancelReason ? { cancelReason } : {}) }),
      });

      if (!response.ok) {
        setNotice({ type: "error", text: await readApiError(response) });
        return;
      }

      const json = (await response.json()) as { booking: MyBooking };
      setBooking(json.booking);
      setNotice({ type: "info", text: cancellationSuccessText(json.booking.outlookSyncStatus) });
    } finally {
      setIsCanceling(false);
    }
  }

  const actionsDisabled = isPending || isSaving || isCanceling;
  const saveDisabled = actionsDisabled || Boolean(selectionConflict);

  return (
    <main className="signin-shell">
      <section className="signin-card manage-card">
        <div className="signin-brand">
          <Image
            src={appPath("/topfly-logo.png")}
            alt="TOPFLY GPS solutions"
            width={678}
            height={147}
            priority
          />
        </div>
        <p className="eyebrow">Gestione prenotazione</p>
        {booking ? (
          <>
            <h1>{isActiveBooking(booking) ? "Gestisci il tuo slot" : "Prenotazione annullata"}</h1>
            <div className="manage-current">
              <span>{bookingStatusLabel(booking.status)}</span>
              <strong>{localDateTime(new Date(booking.start))}</strong>
              <small>{localDateTime(new Date(booking.end))}</small>
              <small>
                Firme scarico: {booking.waiverSignedCount}/{booking.playerCount}
              </small>
              {booking.status === "PENDING_SIGNATURES" ? (
                <small>{deadlineCopy(booking.signatureDeadlineAt)}</small>
              ) : null}
              {booking.status === "CANCELED" && booking.cancelReason ? (
                <small>Motivo annullamento: {booking.cancelReason}</small>
              ) : null}
            </div>

            {booking.status === "PENDING_SIGNATURES" ? (
              <div className="notice warning">
                Se manca anche una sola firma alla scadenza, la prenotazione viene annullata automaticamente.
              </div>
            ) : null}

            {isActiveBooking(booking) ? (
              <>
                <div className="selector-row compact">
                  <label>
                    Giorno
                    <input
                      type="date"
                      value={selectedDate}
                      onChange={(event) => setSelectedDate(event.target.value)}
                    />
                  </label>
                </div>

                <BookingTimeGrid
                  durationOptions={bookingDurationOptions}
                  duration={duration}
                  onDurationChange={setDuration}
                  slots={timelineSlots}
                  onSelectTime={setSelectedTime}
                  compact
                  timelineClassName="timeline manage-timeline"
                  timelineAriaLabel="Orario di inizio"
                  timelineRef={timelineRef}
                  trackSelected
                  busyLabel={(item) => item.organizerName}
                  busyTitle={(item) => `Prenotato da ${item.organizerName}`}
                />

                {selectionConflict ? <div className="notice error" role="alert" aria-live="assertive">{selectionConflict}</div> : null}
                {notice ? (
                  <div
                    aria-live={notice.type === "error" ? "assertive" : "polite"}
                    className={`notice ${notice.type}`}
                    role={notice.type === "error" ? "alert" : "status"}
                  >
                    {notice.text}
                  </div>
                ) : null}
                <button
                  className="primary-button full-width"
                  disabled={saveDisabled}
                  onClick={updateBooking}
                  type="button"
                >
                  <Check size={18} />
                  {isSaving ? "Salvo..." : "Salva modifica"}
                </button>
                <CancelReasonSelect
                  mode={cancelReasonMode}
                  otherText={cancelReasonText}
                  onModeChange={setCancelReasonMode}
                  onOtherTextChange={setCancelReasonText}
                  disabled={actionsDisabled}
                />
                <button
                  className="ghost-button full-width danger-action"
                  disabled={actionsDisabled}
                  onClick={cancelBooking}
                  type="button"
                >
                  <Trash2 size={16} />
                  {isCanceling ? "Cancello..." : "Cancella prenotazione"}
                </button>
              </>
            ) : (
              <>
                {notice ? (
                  <div
                    aria-live={notice.type === "error" ? "assertive" : "polite"}
                    className={`notice ${notice.type}`}
                    role={notice.type === "error" ? "alert" : "status"}
                  >
                    {notice.text}
                  </div>
                ) : null}
                <Link className="ghost-button full-width" href="/">
                  Torna al calendario
                </Link>
              </>
            )}
          </>
        ) : (
          <>
            <h1>Controllo link</h1>
            {notice ? (
              <div
                aria-live={notice.type === "error" ? "assertive" : "polite"}
                className={`notice ${notice.type}`}
                role={notice.type === "error" ? "alert" : "status"}
              >
                {notice.text}
              </div>
            ) : (
              <div className="notice info">
                <Clock3 size={16} />
                Sto caricando la prenotazione.
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}
