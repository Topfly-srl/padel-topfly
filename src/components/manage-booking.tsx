"use client";

import { Check, Clock3, Trash2 } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import { bookingDurationOptions } from "@/lib/booking-constants";
import type { MyBooking } from "@/lib/types";

type Notice = {
  type: "success" | "error" | "info";
  text: string;
};

const tokenStorageKey = "topfly-padel.tokens.v1";

function pad(value: number) {
  return value.toString().padStart(2, "0");
}

function dateKey(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60_000);
}

function dateTimeFromParts(day: string, time: string) {
  return new Date(`${day}T${time}:00`);
}

function minutesBetween(start: Date, end: Date) {
  return Math.round((end.getTime() - start.getTime()) / 60_000);
}

function localDateTime(date: Date) {
  return new Intl.DateTimeFormat("it-IT", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function timeOptions() {
  return Array.from({ length: 96 }, (_, index) => {
    const minutes = index * 15;
    return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
  });
}

function readApiError(response: Response) {
  return response
    .json()
    .then((json: { error?: string }) => json.error ?? "Richiesta non riuscita.")
    .catch(() => "Richiesta non riuscita.");
}

function cancellationSuccessText(status: string) {
  if (status === "SYNCED") return "Prenotazione cancellata. Cancellazione Outlook inviata.";
  if (status === "FAILED") return "Prenotazione cancellata. Cancellazione Outlook non riuscita.";
  return "Prenotazione cancellata.";
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
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selectedDate, setSelectedDate] = useState(dateKey(new Date()));
  const [selectedTime, setSelectedTime] = useState("18:00");
  const [duration, setDuration] = useState(60);
  const [isSaving, setIsSaving] = useState(false);
  const [isCanceling, setIsCanceling] = useState(false);
  const [isPending, startTransition] = useTransition();
  const options = useMemo(() => timeOptions(), []);
  const start = useMemo(
    () => dateTimeFromParts(selectedDate, selectedTime),
    [selectedDate, selectedTime],
  );
  const end = useMemo(() => addMinutes(start, duration), [duration, start]);

  useEffect(() => {
    startTransition(async () => {
      const response = await fetch("/api/bookings/lookup", {
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

  async function updateBooking() {
    if (isSaving || isCanceling) return;

    setNotice(null);
    setIsSaving(true);

    try {
      const response = await fetch(`/api/bookings/${bookingId}`, {
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
      setNotice({ type: "success", text: "Prenotazione aggiornata." });
    } finally {
      setIsSaving(false);
    }
  }

  async function cancelBooking() {
    if (isSaving || isCanceling) return;

    setNotice(null);
    setIsCanceling(true);

    try {
      const response = await fetch(`/api/bookings/${bookingId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manageToken }),
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

  return (
    <main className="signin-shell">
      <section className="signin-card manage-card">
        <div className="signin-brand">
          <Image
            src="/topfly-logo.png"
            alt="TOPFLY GPS solutions"
            width={678}
            height={147}
            priority
          />
        </div>
        <p className="eyebrow">Gestione prenotazione</p>
        {booking ? (
          <>
            <h1>{booking.status === "CONFIRMED" ? "Modifica il tuo slot" : "Prenotazione cancellata"}</h1>
            <div className="manage-current">
              <span>Prenotazione attuale</span>
              <strong>{localDateTime(new Date(booking.start))}</strong>
              <small>{localDateTime(new Date(booking.end))}</small>
            </div>

            {booking.status === "CONFIRMED" ? (
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

                <div className="booking-controls compact-controls">
                  <div>
                    <div className="control-heading">
                      <span>Durata</span>
                    </div>
                    <div className="duration-row" aria-label="Durata prenotazione">
                      {bookingDurationOptions.map((minutes) => (
                        <button
                          className={`duration-chip ${duration === minutes ? "active" : ""}`}
                          key={minutes}
                          onClick={() => setDuration(minutes)}
                          type="button"
                        >
                          {minutes}m
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="control-heading timeline-heading">
                    <span>Orario di inizio</span>
                    <strong>
                      {selectedTime} - {pad(end.getHours())}:{pad(end.getMinutes())}
                    </strong>
                  </div>
                </div>

                <div className="timeline manage-timeline" aria-label="Orario di inizio">
                  {options.map((option) => (
                    <button
                      aria-pressed={option === selectedTime}
                      className={`time-slot ${option === selectedTime ? "selected-start" : ""}`}
                      key={option}
                      onClick={() => setSelectedTime(option)}
                      type="button"
                    >
                      <span>{option}</span>
                    </button>
                  ))}
                </div>

                {notice ? <div className={`notice ${notice.type}`}>{notice.text}</div> : null}
                <button
                  className="primary-button full-width"
                  disabled={actionsDisabled}
                  onClick={updateBooking}
                  type="button"
                >
                  <Check size={18} />
                  {isSaving ? "Salvo..." : "Salva modifica"}
                </button>
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
                {notice ? <div className={`notice ${notice.type}`}>{notice.text}</div> : null}
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
              <div className={`notice ${notice.type}`}>{notice.text}</div>
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
