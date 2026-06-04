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
import { bookingDurationOptions } from "@/lib/booking-constants";
import type {
  AuditItem,
  AvailabilityBlock,
  AvailabilityBooking,
  CurrentUser,
  MyBooking,
} from "@/lib/types";

type AvailabilityResponse = {
  date: string;
  settings: {
    slotMinutes: number;
    minDurationMinutes: number;
    maxDurationMinutes: number;
    maxAdvanceDays: number;
    maxFutureBookings: number;
    durationOptions: readonly number[];
    durationPresets: readonly number[];
    allowedDomain: string;
  };
  bookings: AvailabilityBooking[];
  blocks: AvailabilityBlock[];
};

type Notice = {
  type: "success" | "error" | "info";
  text: string;
};

type StoredIdentity = {
  organizerName: string;
  organizerEmail: string;
};

const identityStorageKey = "topfly-padel.identity.v1";
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

function localDay(date: Date) {
  return new Intl.DateTimeFormat("it-IT", {
    weekday: "short",
    day: "2-digit",
    month: "short",
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

function defaultSelection() {
  const now = new Date();
  const today = dateKey(now);
  const preferred = dateTimeFromParts(today, "18:00");

  if (preferred > now) {
    return { date: today, time: "18:00" };
  }

  const next = new Date(now.getTime() + 15 * 60_000);
  next.setSeconds(0, 0);
  const roundedMinutes = Math.ceil(next.getMinutes() / 15) * 15;
  next.setMinutes(roundedMinutes === 60 ? 0 : roundedMinutes);
  if (roundedMinutes === 60) {
    next.setHours(next.getHours() + 1);
  }

  return {
    date: dateKey(next),
    time: `${pad(next.getHours())}:${pad(next.getMinutes())}`,
  };
}

function dateTimeFromParts(day: string, time: string) {
  return new Date(`${day}T${time}:00`);
}

function rangeOverlaps(start: Date, end: Date, itemStart: string, itemEnd: string) {
  const rightStart = new Date(itemStart);
  const rightEnd = new Date(itemEnd);
  return start < rightEnd && end > rightStart;
}

function rangeMatches(start: Date, end: Date, itemStart: string, itemEnd: string) {
  return start.getTime() === new Date(itemStart).getTime() && end.getTime() === new Date(itemEnd).getTime();
}

async function readApiError(response: Response) {
  const json = (await response.json().catch(() => null)) as { error?: string } | null;
  return json?.error ?? "Richiesta non riuscita.";
}

function syncLabel(status: string) {
  if (status === "SYNCED") return "Invito Outlook inviato";
  if (status === "FAILED") return "Email non inviata";
  if (status === "PENDING") return "Invito Outlook in preparazione";
  return null;
}

function bookingSuccessText(status: string) {
  if (status === "SYNCED") return "Fatto. Prenotazione confermata con invito Outlook.";
  if (status === "FAILED") return "Prenotazione confermata, ma l'email Outlook non e' stata inviata.";
  return "Fatto. Prenotazione confermata.";
}

function readStoredIdentity(): StoredIdentity {
  if (typeof window === "undefined") return { organizerName: "", organizerEmail: "" };

  try {
    const parsed = JSON.parse(window.localStorage.getItem(identityStorageKey) ?? "{}") as Partial<StoredIdentity>;
    return {
      organizerName: typeof parsed.organizerName === "string" ? parsed.organizerName : "",
      organizerEmail: typeof parsed.organizerEmail === "string" ? parsed.organizerEmail : "",
    };
  } catch {
    return { organizerName: "", organizerEmail: "" };
  }
}

function readStoredTokens() {
  if (typeof window === "undefined") return [];

  try {
    const parsed = JSON.parse(window.localStorage.getItem(tokenStorageKey) ?? "[]") as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((token): token is string => typeof token === "string").slice(0, 30)
      : [];
  } catch {
    return [];
  }
}

function writeStoredIdentity(identity: StoredIdentity) {
  window.localStorage.setItem(identityStorageKey, JSON.stringify(identity));
}

function writeStoredTokens(tokens: string[]) {
  window.localStorage.setItem(tokenStorageKey, JSON.stringify(tokens.slice(0, 30)));
}

export function BookingApp({
  adminMode = false,
  initialUser,
}: {
  adminMode?: boolean;
  initialUser?: CurrentUser;
}) {
  const isAdmin = adminMode && initialUser?.role === "ADMIN";
  const [initialSelection] = useState(defaultSelection);
  const [selectedDate, setSelectedDate] = useState(initialSelection.date);
  const [selectedTime, setSelectedTime] = useState(initialSelection.time);
  const [duration, setDuration] = useState(60);
  const [availability, setAvailability] = useState<AvailabilityResponse | null>(null);
  const [myBookings, setMyBookings] = useState<MyBooking[]>([]);
  const [audit, setAudit] = useState<AuditItem[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [editingBookingId, setEditingBookingId] = useState<string | null>(null);
  const [editingToken, setEditingToken] = useState<string | null>(null);
  const [isBookingFormOpen, setIsBookingFormOpen] = useState(false);
  const [organizerName, setOrganizerName] = useState("");
  const [organizerEmail, setOrganizerEmail] = useState("");
  const [localTokens, setLocalTokens] = useState<string[]>([]);
  const [storageReady, setStorageReady] = useState(false);
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
  const durationOptions = availability?.settings.durationOptions ?? bookingDurationOptions;
  const start = useMemo(
    () => dateTimeFromParts(selectedDate, selectedTime),
    [selectedDate, selectedTime],
  );
  const end = useMemo(() => addMinutes(start, duration), [duration, start]);

  const dayBookings = useMemo(() => availability?.bookings ?? [], [availability?.bookings]);
  const dayBlocks = useMemo(() => availability?.blocks ?? [], [availability?.blocks]);
  const activeMyBookingCount = useMemo(
    () => myBookings.filter((booking) => booking.status === "CONFIRMED").length,
    [myBookings],
  );
  const allowedDomain = availability?.settings.allowedDomain ?? "azienda.it";
  const isExternalEmail =
    organizerEmail.trim().includes("@") &&
    !organizerEmail.trim().toLowerCase().endsWith(`@${allowedDomain}`);

  const selectedOwnBooking = useMemo(
    () =>
      myBookings.find(
        (booking) =>
          booking.status === "CONFIRMED" &&
          rangeMatches(start, end, booking.start, booking.end),
      ) ?? null,
    [end, myBookings, start],
  );
  const isConfirmedSelection = Boolean(selectedOwnBooking) && !editingBookingId;
  const ignoredBookingId = editingBookingId ?? selectedOwnBooking?.id ?? null;

  const selectionConflict = useMemo(() => {
    const booking = dayBookings.find(
      (item) => item.id !== ignoredBookingId && rangeOverlaps(start, end, item.start, item.end),
    );
    if (booking) return `Occupato da ${booking.organizerName}`;

    const block = dayBlocks.find((item) => rangeOverlaps(start, end, item.start, item.end));
    if (block) return `Bloccato: ${block.reason}`;

    return null;
  }, [dayBlocks, dayBookings, end, ignoredBookingId, start]);

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
    if (!isAdmin) return;

    const response = await fetch("/api/admin/audit", { cache: "no-store" });
    if (response.ok) {
      const json = (await response.json()) as { audit: AuditItem[] };
      setAudit(json.audit);
    }
  }, [isAdmin]);

  const loadMyBookings = useCallback(async (tokens: string[]) => {
    if (!tokens.length) {
      setMyBookings([]);
      return;
    }

    const response = await fetch("/api/bookings/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokens }),
    });

    if (response.ok) {
      const json = (await response.json()) as { bookings: MyBooking[] };
      setMyBookings(json.bookings);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const identity = readStoredIdentity();
      setOrganizerName(identity.organizerName);
      setOrganizerEmail(identity.organizerEmail);
      setLocalTokens(readStoredTokens());
      setStorageReady(true);
    }, 0);

    return () => window.clearTimeout(timer);
  }, []);

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
    if (!storageReady) return;

    startTransition(async () => {
      await loadMyBookings(localTokens);
    });
  }, [loadMyBookings, localTokens, storageReady]);

  useEffect(() => {
    const timeline = timelineRef.current;
    const selected = timeline?.querySelector<HTMLElement>("[data-selected='true']");

    if (!timeline || !selected) return;

    timeline.scrollTop = Math.max(
      0,
      selected.offsetTop - timeline.offsetTop - timeline.clientHeight / 2 + selected.clientHeight / 2,
    );
  }, [availability?.blocks, availability?.bookings, duration, selectedDate, selectedTime]);

  async function refresh(tokens = localTokens) {
    await loadAvailability();
    await loadAudit();
    await loadMyBookings(tokens);
  }

  function rememberIdentity() {
    const nextIdentity = {
      organizerName: organizerName.trim(),
      organizerEmail: organizerEmail.trim(),
    };
    writeStoredIdentity(nextIdentity);
  }

  function rememberToken(token: string) {
    const nextTokens = [token, ...localTokens.filter((item) => item !== token)].slice(0, 30);
    writeStoredTokens(nextTokens);
    setLocalTokens(nextTokens);
    return nextTokens;
  }

  async function saveBooking() {
    setNotice(null);

    if (!editingBookingId && !isBookingFormOpen) {
      setIsBookingFormOpen(true);
      return;
    }

    const isEditing = Boolean(editingBookingId);
    const body = isEditing
      ? {
          start: start.toISOString(),
          end: end.toISOString(),
          manageToken: editingToken ?? undefined,
        }
      : {
          start: start.toISOString(),
          end: end.toISOString(),
          organizerName,
          organizerEmail,
        };

    const response = await fetch(isEditing ? `/api/bookings/${editingBookingId}` : "/api/bookings", {
      method: isEditing ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      setNotice({ type: "error", text: await readApiError(response) });
      return;
    }

    const json = (await response.json()) as { booking: MyBooking };
    let nextTokens = localTokens;

    if (!isEditing) {
      rememberIdentity();
      if (json.booking.manageToken) {
        nextTokens = rememberToken(json.booking.manageToken);
      }
    }

    setEditingBookingId(null);
    setEditingToken(null);
    setIsBookingFormOpen(false);
      setNotice({
        type: json.booking.outlookSyncStatus === "FAILED" ? "info" : "success",
        text: bookingSuccessText(json.booking.outlookSyncStatus),
      });
    await refresh(nextTokens);
  }

  async function cancelBooking(booking: MyBooking | AvailabilityBooking) {
    const manageToken = "manageToken" in booking ? booking.manageToken : undefined;

    if (!isAdmin && !manageToken) {
      setNotice({ type: "error", text: "Apri il link ricevuto via email per cancellare questa prenotazione." });
      return;
    }

    const response = await fetch(`/api/bookings/${booking.id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manageToken }),
    });

    if (!response.ok) {
      setNotice({ type: "error", text: await readApiError(response) });
      return;
    }

    setNotice({ type: "info", text: "Prenotazione cancellata." });
    await refresh();
  }

  function editBooking(booking: MyBooking | AvailabilityBooking) {
    const manageToken = "manageToken" in booking ? booking.manageToken : undefined;

    if (!isAdmin && !manageToken) {
      setNotice({ type: "error", text: "Apri il link ricevuto via email per modificare questa prenotazione." });
      return;
    }

    const bookingStart = new Date(booking.start);
    const bookingEnd = new Date(booking.end);

    setSelectedDate(dateKey(bookingStart));
    setSelectedTime(`${pad(bookingStart.getHours())}:${pad(bookingStart.getMinutes())}`);
    setDuration(minutesBetween(bookingStart, bookingEnd));
    setEditingBookingId(booking.id);
    setEditingToken(manageToken ?? null);
    setIsBookingFormOpen(false);
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
    await refresh();
  }

  async function deleteBlock(id: string) {
    const response = await fetch(`/api/admin/blocks/${id}`, { method: "DELETE" });

    if (!response.ok) {
      setNotice({ type: "error", text: await readApiError(response) });
      return;
    }

    setNotice({ type: "info", text: "Blocco rimosso." });
    await refresh();
  }

  const canSave = !selectionConflict && !isPending && !isConfirmedSelection;

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
            <h1>
              {isAdmin
                ? `Admin ${initialUser?.name?.split(" ")[0] ?? initialUser?.email.split("@")[0]}`
                : "Prenota il campo"}
            </h1>
          </div>
        </div>
        {isAdmin ? (
          <button
            className="icon-button"
            onClick={() => signOut({ callbackUrl: "/signin" })}
            type="button"
            aria-label="Esci"
            title="Esci"
          >
            <LogOut size={18} />
          </button>
        ) : null}
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

            <div className="booking-controls">
              <div>
                <div className="control-heading">
                  <span>Durata</span>
                </div>
                <div className="duration-row" aria-label="Durata prenotazione">
                  {durationOptions.map((minutes) => (
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
                  {localTime(start)} - {localTime(end)}
                </strong>
              </div>
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
                const isSelectedStart = option === selectedTime;

                return (
                  <button
                    className={`time-slot ${booking ? "busy" : ""} ${block ? "blocked" : ""} ${
                      isSelectedStart ? "selected-start" : isSelected ? "selected-range" : ""
                    }`}
                    data-selected={isSelected ? "true" : undefined}
                    disabled={Boolean(booking || block)}
                    key={option}
                    onClick={() => setSelectedTime(option)}
                    aria-pressed={isSelectedStart}
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
              <span>Max 2 future per email</span>
              <span>15-120 min</span>
            </div>

            {selectedOwnBooking && isConfirmedSelection ? (
              <div className="confirmed-summary">
                <div className="notice success">
                  <Check size={16} />
                  <div>
                    <strong>Prenotazione confermata</strong>
                    {syncLabel(selectedOwnBooking.outlookSyncStatus) ? (
                      <span>{syncLabel(selectedOwnBooking.outlookSyncStatus)}</span>
                    ) : null}
                  </div>
                </div>
                <div className="summary-actions">
                  <button className="ghost-button full-width" onClick={() => editBooking(selectedOwnBooking)} type="button">
                    <Edit3 size={16} />
                    Modifica
                  </button>
                  <button
                    className="ghost-button full-width danger-action"
                    onClick={() => cancelBooking(selectedOwnBooking)}
                    type="button"
                  >
                    <Trash2 size={16} />
                    Cancella
                  </button>
                </div>
              </div>
            ) : selectionConflict ? (
              <div className="notice error">{selectionConflict}</div>
            ) : notice ? (
              <div className={`notice ${notice.type}`}>{notice.text}</div>
            ) : (
              <div className="notice success">
                <MailCheck size={16} />
                Conferma via email + link modifica/cancella
              </div>
            )}

            {isBookingFormOpen && !editingBookingId ? (
              <div className="booking-form">
                <label>
                  Nome e cognome
                  <input
                    autoComplete="name"
                    value={organizerName}
                    onChange={(event) => setOrganizerName(event.target.value)}
                    placeholder="Mario Rossi"
                  />
                </label>
                <label>
                  Email
                  <input
                    autoComplete="email"
                    inputMode="email"
                    value={organizerEmail}
                    onChange={(event) => setOrganizerEmail(event.target.value)}
                    placeholder={`nome@${allowedDomain}`}
                  />
                </label>
                {isExternalEmail ? (
                  <div className="notice info">
                    Puoi usare questa email, ma quella aziendale aiuta a riconoscerti meglio.
                  </div>
                ) : null}
              </div>
            ) : null}

            {isConfirmedSelection ? null : (
              <button
                className="primary-button full-width"
                disabled={!canSave}
                onClick={saveBooking}
                type="button"
              >
                <Check size={18} />
                {selectionConflict
                  ? "Slot occupato"
                  : editingBookingId
                    ? "Salva modifica"
                    : isBookingFormOpen
                      ? "Conferma prenotazione"
                      : "Prenota"}
              </button>
            )}

            {editingBookingId || isBookingFormOpen ? (
              <button
                className="ghost-button full-width"
                onClick={() => {
                  setEditingBookingId(null);
                  setEditingToken(null);
                  setIsBookingFormOpen(false);
                  setNotice(null);
                }}
                type="button"
              >
                Annulla
              </button>
            ) : null}
          </section>

          <section className="panel">
            <div className="section-title spread">
              <span>Le mie prenotazioni</span>
              <span className="count-pill">{activeMyBookingCount}</span>
            </div>
            <div className="booking-list">
              {myBookings.length ? (
                myBookings.map((booking) => (
                  <article
                    className={`booking-item compact ${booking.status.toLowerCase()} ${
                      selectedOwnBooking?.id === booking.id ? "selected-booking" : ""
                    }`}
                    key={booking.id}
                  >
                    <div>
                      <strong>
                        {localDay(new Date(booking.start))}, {localTime(new Date(booking.start))} -{" "}
                        {localTime(new Date(booking.end))}
                      </strong>
                      <small>
                        {booking.status === "CONFIRMED" ? "Confermata" : "Cancellata"}
                        {syncLabel(booking.outlookSyncStatus) ? ` · ${syncLabel(booking.outlookSyncStatus)}` : ""}
                      </small>
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
                          onClick={() => cancelBooking(booking)}
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
                <p className="empty-state">Nessuna prenotazione salvata su questo dispositivo.</p>
              )}
            </div>
          </section>

          {isAdmin ? (
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
                          onClick={() => cancelBooking(booking)}
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
