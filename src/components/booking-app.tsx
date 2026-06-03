"use client";

import {
  CalendarDays,
  Check,
  Clock3,
  Edit3,
  Lock,
  LogOut,
  MailCheck,
  Shield,
  Trash2,
} from "lucide-react";
import Image from "next/image";
import { signOut } from "next-auth/react";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import type {
  AuditItem,
  AvailabilityBlock,
  AvailabilityBooking,
  CurrentUser,
  MyBooking,
} from "@/lib/types";

type AvailabilityResponse = {
  date: string;
  user: CurrentUser;
  settings: {
    slotMinutes: number;
    minDurationMinutes: number;
    maxDurationMinutes: number;
    maxAdvanceDays: number;
    maxFutureBookings: number;
    durationPresets: readonly number[];
  };
  bookings: AvailabilityBooking[];
  blocks: AvailabilityBlock[];
  myBookings: MyBooking[];
};

type Notice = {
  type: "success" | "error" | "info";
  text: string;
};

const durationPresets = [30, 45, 60, 90, 120];

function pad(value: number) {
  return value.toString().padStart(2, "0");
}

function dateKey(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60_000);
}

function minutesBetween(start: Date, end: Date) {
  return Math.round((end.getTime() - start.getTime()) / 60_000);
}

function localTime(date: Date) {
  return new Intl.DateTimeFormat("it-IT", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
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

function humanDay(date: Date) {
  const today = dateKey(new Date());
  const tomorrow = dateKey(addMinutes(new Date(), 24 * 60));
  const key = dateKey(date);

  if (key === today) return "Oggi";
  if (key === tomorrow) return "Domani";

  return new Intl.DateTimeFormat("it-IT", {
    weekday: "short",
  }).format(date);
}

function timeOptions() {
  return Array.from({ length: 96 }, (_, index) => {
    const minutes = index * 15;
    return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
  });
}

function dateTimeFromParts(day: string, time: string) {
  return new Date(`${day}T${time}:00`);
}

function rangeOverlaps(start: Date, end: Date, itemStart: string, itemEnd: string) {
  const rightStart = new Date(itemStart);
  const rightEnd = new Date(itemEnd);
  return start < rightEnd && end > rightStart;
}

async function readApiError(response: Response) {
  const json = (await response.json().catch(() => null)) as { error?: string } | null;
  return json?.error ?? "Richiesta non riuscita.";
}

function syncLabel(status: string) {
  if (status === "SYNCED") return "Outlook ok";
  if (status === "FAILED") return "Outlook da controllare";
  if (status === "SKIPPED") return "Outlook non configurato";
  return "Outlook in corso";
}

export function BookingApp({ initialUser }: { initialUser: CurrentUser }) {
  const [selectedDate, setSelectedDate] = useState(dateKey(new Date()));
  const [selectedTime, setSelectedTime] = useState("18:00");
  const [duration, setDuration] = useState(60);
  const [availability, setAvailability] = useState<AvailabilityResponse | null>(null);
  const [audit, setAudit] = useState<AuditItem[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [editingBookingId, setEditingBookingId] = useState<string | null>(null);
  const [blockStart, setBlockStart] = useState("09:00");
  const [blockEnd, setBlockEnd] = useState("10:00");
  const [blockReason, setBlockReason] = useState("Manutenzione");
  const [isPending, startTransition] = useTransition();
  const timelineRef = useRef<HTMLDivElement | null>(null);

  const dates = useMemo(
    () =>
      Array.from({ length: 15 }, (_, index) => {
        const date = new Date();
        date.setHours(0, 0, 0, 0);
        date.setDate(date.getDate() + index);
        return date;
      }),
    [],
  );

  const options = useMemo(() => timeOptions(), []);
  const start = useMemo(
    () => dateTimeFromParts(selectedDate, selectedTime),
    [selectedDate, selectedTime],
  );
  const end = useMemo(() => addMinutes(start, duration), [duration, start]);

  const dayBookings = useMemo(() => availability?.bookings ?? [], [availability?.bookings]);
  const dayBlocks = useMemo(() => availability?.blocks ?? [], [availability?.blocks]);
  const activeMyBookingCount = useMemo(
    () =>
      availability?.myBookings.filter((booking) => booking.status === "CONFIRMED").length ?? 0,
    [availability?.myBookings],
  );

  const selectionConflict = useMemo(() => {
    const booking = dayBookings.find((item) => rangeOverlaps(start, end, item.start, item.end));
    if (booking) return `Occupato da ${booking.organizerName}`;

    const block = dayBlocks.find((item) => rangeOverlaps(start, end, item.start, item.end));
    if (block) return `Bloccato: ${block.reason}`;

    return null;
  }, [dayBlocks, dayBookings, end, start]);

  const loadAvailability = useCallback(async () => {
    const response = await fetch(`/api/availability?date=${selectedDate}`, {
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(await readApiError(response));
    }

    setAvailability((await response.json()) as AvailabilityResponse);
  }, [selectedDate]);

  const loadAudit = useCallback(async () => {
    if (initialUser.role !== "ADMIN") return;

    const response = await fetch("/api/admin/audit", { cache: "no-store" });
    if (response.ok) {
      const json = (await response.json()) as { audit: AuditItem[] };
      setAudit(json.audit);
    }
  }, [initialUser.role]);

  useEffect(() => {
    startTransition(async () => {
      try {
        await loadAvailability();
        await loadAudit();
      } catch (error) {
        setNotice({
          type: "error",
          text: error instanceof Error ? error.message : "Impossibile caricare il calendario.",
        });
      }
    });
  }, [loadAudit, loadAvailability]);

  useEffect(() => {
    const timeline = timelineRef.current;
    const selected = timeline?.querySelector<HTMLElement>("[data-selected='true']");

    if (!timeline || !selected) return;

    timeline.scrollTop = Math.max(
      0,
      selected.offsetTop - timeline.offsetTop - timeline.clientHeight / 2 + selected.clientHeight / 2,
    );
  }, [availability?.blocks, availability?.bookings, duration, selectedDate, selectedTime]);

  function refresh() {
    startTransition(async () => {
      await loadAvailability();
      await loadAudit();
    });
  }

  async function saveBooking() {
    setNotice(null);

    const response = await fetch(
      editingBookingId ? `/api/bookings/${editingBookingId}` : "/api/bookings",
      {
        method: editingBookingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start: start.toISOString(),
          end: end.toISOString(),
        }),
      },
    );

    if (!response.ok) {
      setNotice({ type: "error", text: await readApiError(response) });
      return;
    }

    setEditingBookingId(null);
    setNotice({
      type: "success",
      text: "Fatto. Prenotazione confermata con invito Outlook e promemoria 1h.",
    });
    refresh();
  }

  async function cancelBooking(id: string) {
    const response = await fetch(`/api/bookings/${id}`, { method: "DELETE" });

    if (!response.ok) {
      setNotice({ type: "error", text: await readApiError(response) });
      return;
    }

    setNotice({ type: "info", text: "Prenotazione cancellata." });
    refresh();
  }

  function editBooking(booking: MyBooking | AvailabilityBooking) {
    const bookingStart = new Date(booking.start);
    const bookingEnd = new Date(booking.end);

    setSelectedDate(dateKey(bookingStart));
    setSelectedTime(`${pad(bookingStart.getHours())}:${pad(bookingStart.getMinutes())}`);
    setDuration(minutesBetween(bookingStart, bookingEnd));
    setEditingBookingId(booking.id);
    setNotice({ type: "info", text: "Modifica gli orari e salva." });
  }

  async function createBlock() {
    const response = await fetch("/api/admin/blocks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        start: dateTimeFromParts(selectedDate, blockStart).toISOString(),
        end: dateTimeFromParts(selectedDate, blockEnd).toISOString(),
        reason: blockReason,
      }),
    });

    if (!response.ok) {
      setNotice({ type: "error", text: await readApiError(response) });
      return;
    }

    setNotice({ type: "success", text: "Blocco admin creato." });
    refresh();
  }

  async function deleteBlock(id: string) {
    const response = await fetch(`/api/admin/blocks/${id}`, { method: "DELETE" });

    if (!response.ok) {
      setNotice({ type: "error", text: await readApiError(response) });
      return;
    }

    setNotice({ type: "info", text: "Blocco rimosso." });
    refresh();
  }

  const canSave = !selectionConflict && !isPending;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <Image
            src="/topfly-logo.png"
            alt="TOPFLY GPS solutions"
            width={678}
            height={147}
            priority
          />
          <div>
            <p className="muted-label">Padel aziendale</p>
            <h1>Ciao {initialUser.name?.split(" ")[0] ?? initialUser.email.split("@")[0]}</h1>
          </div>
        </div>
        <button
          className="icon-button"
          onClick={() => signOut({ callbackUrl: "/signin" })}
          type="button"
          aria-label="Esci"
          title="Esci"
        >
          <LogOut size={18} />
        </button>
      </header>

      <section className="main-grid">
        <div className="booking-flow">
          <section className="panel date-panel">
            <div className="section-title">
              <CalendarDays size={18} />
              <span>Scegli giorno</span>
            </div>
            <div className="date-strip" aria-label="Giorni disponibili">
              {dates.map((date) => {
                const key = dateKey(date);
                return (
                  <button
                    className={`date-chip ${key === selectedDate ? "active" : ""}`}
                    key={key}
                    onClick={() => setSelectedDate(key)}
                    type="button"
                  >
                    <span>{humanDay(date)}</span>
                    <strong>{new Intl.DateTimeFormat("it-IT", { day: "2-digit" }).format(date)}</strong>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="panel">
            <div className="section-title spread">
              <span className="title-with-icon">
                <Clock3 size={18} />
                Scegli orario
              </span>
              {isPending ? <span className="loading-pill">Aggiorno</span> : null}
            </div>

            <div className="selector-row">
              <label>
                Inizio
                <select value={selectedTime} onChange={(event) => setSelectedTime(event.target.value)}>
                  {options.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Durata
                <select
                  value={duration}
                  onChange={(event) => setDuration(Number(event.target.value))}
                >
                  {Array.from({ length: 8 }, (_, index) => 15 + index * 15).map((minutes) => (
                    <option key={minutes} value={minutes}>
                      {minutes} min
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="duration-row" aria-label="Durate rapide">
              {durationPresets.map((minutes) => (
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

            <div className="timeline" aria-label="Disponibilita del giorno" ref={timelineRef}>
              {options.map((option) => {
                const slotStart = dateTimeFromParts(selectedDate, option);
                const slotEnd = addMinutes(slotStart, 15);
                const booking = dayBookings.find((item) =>
                  rangeOverlaps(slotStart, slotEnd, item.start, item.end),
                );
                const block = dayBlocks.find((item) =>
                  rangeOverlaps(slotStart, slotEnd, item.start, item.end),
                );
                const isSelected = rangeOverlaps(slotStart, slotEnd, start.toISOString(), end.toISOString());

                return (
                  <button
                    className={`time-slot ${booking ? "busy" : ""} ${block ? "blocked" : ""} ${
                      isSelected ? "selected" : ""
                    }`}
                    data-selected={isSelected ? "true" : undefined}
                    disabled={Boolean(booking || block)}
                    key={option}
                    onClick={() => setSelectedTime(option)}
                    type="button"
                    title={booking ? `Prenotato da ${booking.organizerName}` : block?.reason}
                  >
                    <span>{option}</span>
                    {booking ? <small>{booking.organizerName}</small> : null}
                    {block ? <small>{block.reason}</small> : null}
                  </button>
                );
              })}
            </div>
          </section>
        </div>

        <aside className="side-stack">
          <section className="summary-card">
            <div className="summary-top">
              <div>
                <p className="muted-label">Riepilogo</p>
                <h2>
                  {localDateTime(start)} - {localTime(end)}
                </h2>
              </div>
              <div className={`status-dot ${selectionConflict ? "bad" : "good"}`} />
            </div>

            <div className="rules">
              <span>Max 14 giorni</span>
              <span>Max 2 future</span>
              <span>15-120 min</span>
            </div>

            {selectionConflict ? (
              <div className="notice error">{selectionConflict}</div>
            ) : (
              <div className="notice success">
                <MailCheck size={16} />
                Invito Outlook + promemoria 1h
              </div>
            )}

            {notice ? <div className={`notice ${notice.type}`}>{notice.text}</div> : null}

            <button
              className="primary-button full-width"
              disabled={!canSave}
              onClick={saveBooking}
              type="button"
            >
              <Check size={18} />
              {editingBookingId ? "Salva modifica" : "Prenota"}
            </button>

            {editingBookingId ? (
              <button
                className="ghost-button full-width"
                onClick={() => {
                  setEditingBookingId(null);
                  setNotice(null);
                }}
                type="button"
              >
                Annulla modifica
              </button>
            ) : null}
          </section>

          <section className="panel">
            <div className="section-title spread">
              <span>Le mie prenotazioni</span>
              <span className="count-pill">{activeMyBookingCount}</span>
            </div>
            <div className="booking-list">
              {availability?.myBookings.length ? (
                availability.myBookings.map((booking) => (
                  <article className={`booking-item ${booking.status.toLowerCase()}`} key={booking.id}>
                    <div>
                      <strong>{localDateTime(new Date(booking.start))}</strong>
                      <span>
                        {localTime(new Date(booking.start))} - {localTime(new Date(booking.end))}
                      </span>
                      <small>
                        {booking.status === "CONFIRMED" ? "Confermata" : "Cancellata"}
                      </small>
                      <small>{syncLabel(booking.outlookSyncStatus)}</small>
                    </div>
                    {booking.status === "CONFIRMED" ? (
                      <div className="item-actions">
                        <button
                          className="mini-button"
                          onClick={() => editBooking(booking)}
                          type="button"
                          aria-label="Modifica"
                          title="Modifica"
                        >
                          <Edit3 size={15} />
                        </button>
                        <button
                          className="mini-button danger"
                          onClick={() => cancelBooking(booking.id)}
                          type="button"
                          aria-label="Cancella"
                          title="Cancella"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    ) : null}
                  </article>
                ))
              ) : (
                <p className="empty-state">Nessuna prenotazione attiva. Il campo aspetta te.</p>
              )}
            </div>
          </section>

          {initialUser.role === "ADMIN" ? (
            <section className="panel admin-panel">
              <div className="section-title">
                <Shield size={18} />
                <span>Admin</span>
              </div>

              <details>
                <summary>Blocchi admin</summary>
                <div className="selector-row compact">
                  <label>
                    Da
                    <select value={blockStart} onChange={(event) => setBlockStart(event.target.value)}>
                      {options.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    A
                    <select value={blockEnd} onChange={(event) => setBlockEnd(event.target.value)}>
                      {options.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="stack-label">
                  Motivo
                  <input
                    value={blockReason}
                    onChange={(event) => setBlockReason(event.target.value)}
                  />
                </label>
                <button className="ghost-button full-width" onClick={createBlock} type="button">
                  <Lock size={16} />
                  Blocca fascia
                </button>

                {dayBlocks.length ? (
                  <div className="booking-list">
                    {dayBlocks.map((block) => (
                      <article className="booking-item blocked-item" key={block.id}>
                        <div>
                          <strong>
                            {localTime(new Date(block.start))} - {localTime(new Date(block.end))}
                          </strong>
                          <span>{block.reason}</span>
                        </div>
                        <button
                          className="mini-button danger"
                          onClick={() => deleteBlock(block.id)}
                          type="button"
                          aria-label="Rimuovi blocco"
                          title="Rimuovi blocco"
                        >
                          <Trash2 size={15} />
                        </button>
                      </article>
                    ))}
                  </div>
                ) : null}
              </details>

              <details>
                <summary>Prenotazioni del giorno</summary>
                <div className="booking-list">
                  {dayBookings.map((booking) => (
                    <article className="booking-item" key={booking.id}>
                      <div>
                        <strong>{booking.organizerName}</strong>
                        <span>
                          {localTime(new Date(booking.start))} - {localTime(new Date(booking.end))}
                        </span>
                      </div>
                      <div className="item-actions">
                        <button className="mini-button" onClick={() => editBooking(booking)} type="button">
                          <Edit3 size={15} />
                        </button>
                        <button
                          className="mini-button danger"
                          onClick={() => cancelBooking(booking.id)}
                          type="button"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              </details>

              <details>
                <summary>Storico recente</summary>
                <div className="audit-list">
                  {audit.map((item) => (
                    <div className="audit-row" key={item.id}>
                      <span>{item.action}</span>
                      <small>
                        {item.actorEmail} - {localDateTime(new Date(item.createdAt))}
                      </small>
                    </div>
                  ))}
                </div>
              </details>
            </section>
          ) : null}
        </aside>
      </section>
    </main>
  );
}
