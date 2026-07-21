"use client";

import {
  CalendarDays,
  Check,
  Clock3,
  Edit3,
  FileText,
  LogOut,
  MailWarning,
  Trash2,
} from "lucide-react";
import Image from "next/image";
import { signOut } from "next-auth/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { appPath } from "@/lib/app-path";
import { bookingDurationOptions } from "@/lib/booking-constants";
import { bookingStatusLabel } from "@/lib/booking-copy";
import {
  dateTimeFromParts,
  errorText,
  localTime,
  networkErrorText,
  pad,
  readApiError,
  syncLabel,
  type Notice,
} from "@/lib/booking-ui";
import { buildShortGuestWaiverLink } from "@/lib/guest-waiver-link";
import {
  bookingTimeOptions,
  computeTimelineSlots,
  findOverlappingTimelineItem,
  type TimelineRange,
} from "@/lib/timeline-slots";
import type { BookingInitialState } from "@/lib/booking-initial-state";
import type {
  AdminStats,
  AuditAction,
  AuditItem,
  AvailabilityBlock,
  AvailabilityBooking,
  CurrentUser,
  MyBooking,
} from "@/lib/types";
import { AdminPanel } from "@/components/admin/admin-panel";
import { type AdminWaiverItem } from "@/components/admin/admin-waivers-section";
import { BookingTimeGrid } from "@/components/booking-time-grid";
import { GuestLinkPanel } from "@/components/guest-link-panel";
import { MyBookingsSection } from "@/components/my-bookings-section";
import { PendingSignaturePanel } from "@/components/pending-signature-panel";

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

type GuestWaiverLinks = Record<string, string>;

const tokenStorageKey = "topfly-padel.tokens.v1";
const guestWaiverLinksStorageKey = "topfly-padel.guest-waiver-links.v1";
// La griglia oraria copre sempre l'intera giornata: e' una costante, non dipende da impostazioni.
const options = bookingTimeOptions();
const adminWaiverPageSize = 50;
const adminAuditPageSize = 40;

const fallbackInitialState: BookingInitialState = {
  date: "1970-01-01",
  time: "18:00",
  dateKeys: ["1970-01-01"],
};
function dateKey(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60_000);
}

function minutesBetween(start: Date, end: Date) {
  return Math.round((end.getTime() - start.getTime()) / 60_000);
}

function durationLabel(minutes: number) {
  if (minutes === 60) return "1 ora";
  if (minutes % 60 === 0) return `${minutes / 60} ore`;
  return `${minutes} min`;
}

function localSummaryDay(date: Date) {
  return new Intl.DateTimeFormat("it-IT", {
    weekday: "long",
    day: "2-digit",
    month: "long",
  }).format(date);
}

function humanDay(date: Date, today: string, tomorrow: string) {
  const key = dateKey(date);

  if (key === today) return "Oggi";
  if (key === tomorrow) return "Domani";

  return new Intl.DateTimeFormat("it-IT", {
    weekday: "short",
  }).format(date);
}

function rangeMatches(start: Date, end: Date, itemStart: string, itemEnd: string) {
  return start.getTime() === new Date(itemStart).getTime() && end.getTime() === new Date(itemEnd).getTime();
}

function isActiveBooking(booking: Pick<AvailabilityBooking, "status">) {
  return booking.status === "CONFIRMED" || booking.status === "PENDING_SIGNATURES";
}

function bookingSuccessText(status: string) {
  if (status === "SYNCED") return "Fatto. Prenotazione confermata con invito Outlook.";
  if (status === "FAILED") return "Prenotazione confermata, ma l'invito Outlook non è stato inviato.";
  return "Fatto. Prenotazione confermata.";
}

function cancellationSuccessText(status: string) {
  if (status === "SYNCED") return "Prenotazione annullata. Cancellazione Outlook inviata.";
  if (status === "FAILED") return "Prenotazione annullata. Cancellazione Outlook non riuscita.";
  return "Prenotazione annullata.";
}

function waiverDeliveryCopy(status: AdminWaiverItem["emailStatus"] | null) {
  if (status === "SENT") {
    return {
      tone: "success",
      title: "Modulo ufficiale inviato alla Direzione",
      text: "Il PDF è stato compilato, archiviato e inviato alla mailbox Padel.",
    };
  }

  if (status === "FAILED") {
    return {
      tone: "warning",
      title: "PDF salvato, email da reinviare",
      text: "La firma resta registrata. Il PDF si può scaricare o reinviare da admin.",
    };
  }

  if (status === "SKIPPED") {
    return {
      tone: "warning",
      title: "PDF salvato in archivio",
      text: "L'invio email non è configurato: il modulo resta disponibile nell'admin.",
    };
  }

  return {
    tone: "neutral",
    title: "Modulo ufficiale in preparazione",
    text: "Generiamo il PDF firmato dal modello TOPFLY e lo rendiamo disponibile alla Direzione.",
  };
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

function readStoredGuestWaiverLinks(): GuestWaiverLinks {
  if (typeof window === "undefined") return {};

  try {
    const parsed = JSON.parse(window.localStorage.getItem(guestWaiverLinksStorageKey) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

function writeStoredGuestWaiverLinks(links: GuestWaiverLinks) {
  window.localStorage.setItem(guestWaiverLinksStorageKey, JSON.stringify(links));
}

export function BookingApp({
  adminMode = false,
  initialAvailability = null,
  initialState = fallbackInitialState,
  initialUser,
}: {
  adminMode?: boolean;
  initialAvailability?: AvailabilityResponse | null;
  initialState?: BookingInitialState;
  initialUser?: CurrentUser;
}) {
  const isAdmin = adminMode && initialUser?.role === "ADMIN";
  const [selectedDate, setSelectedDate] = useState(initialState.date);
  const [selectedTime, setSelectedTime] = useState(initialState.time);
  const [duration, setDuration] = useState(60);
  const [availability, setAvailability] = useState<AvailabilityResponse | null>(initialAvailability);
  const [myBookings, setMyBookings] = useState<MyBooking[]>([]);
  const [audit, setAudit] = useState<AuditItem[]>([]);
  const [auditActionFilter, setAuditActionFilter] = useState<AuditAction | "ALL">("ALL");
  const [auditNextCursor, setAuditNextCursor] = useState<string | null>(null);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [editingBookingId, setEditingBookingId] = useState<string | null>(null);
  const [editingToken, setEditingToken] = useState<string | null>(null);
  const [localTokens, setLocalTokens] = useState<string[]>([]);
  const [guestWaiverLinks, setGuestWaiverLinks] = useState<GuestWaiverLinks>({});
  const [copiedGuestWaiverLink, setCopiedGuestWaiverLink] = useState<string | null>(null);
  const [adminWaivers, setAdminWaivers] = useState<AdminWaiverItem[]>([]);
  const [adminWaiverStatusFilter, setAdminWaiverStatusFilter] = useState<AdminWaiverItem["emailStatus"] | "ALL">("ALL");
  const [adminWaiverRoleFilter, setAdminWaiverRoleFilter] = useState<AdminWaiverItem["signerRole"] | "ALL">("ALL");
  const [adminWaiverQuery, setAdminWaiverQuery] = useState("");
  const [adminWaiverNextCursor, setAdminWaiverNextCursor] = useState<string | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [isAvailabilityLoading, setIsAvailabilityLoading] = useState(!initialAvailability);
  const [isMyBookingsLoading, setIsMyBookingsLoading] = useState(false);
  const [isAuditLoading, setIsAuditLoading] = useState(false);
  const [isStatsLoading, setIsStatsLoading] = useState(false);
  const [isAdminWaiversLoading, setIsAdminWaiversLoading] = useState(false);
  const timelineRef = useRef<HTMLDivElement | null>(null);

  const dates = useMemo(
    () =>
      initialState.dateKeys.map((key) => dateTimeFromParts(key, "00:00")),
    [initialState.dateKeys],
  );

  const currentAvailability = availability?.date === selectedDate ? availability : null;
  const isAvailabilityBusy = isAvailabilityLoading || availability?.date !== selectedDate;
  const isAdminLoading = isAuditLoading || isStatsLoading || isAdminWaiversLoading;
  const durationOptions = currentAvailability?.settings.durationOptions ?? bookingDurationOptions;
  const start = useMemo(
    () => dateTimeFromParts(selectedDate, selectedTime),
    [selectedDate, selectedTime],
  );
  const end = useMemo(() => addMinutes(start, duration), [duration, start]);

  const dayBookings = useMemo(() => currentAvailability?.bookings ?? [], [currentAvailability?.bookings]);
  const dayBlocks = useMemo(() => currentAvailability?.blocks ?? [], [currentAvailability?.blocks]);
  const activeMyBookings = useMemo(
    () => myBookings.filter(isActiveBooking),
    [myBookings],
  );
  const activeMyBookingCount = useMemo(
    () => activeMyBookings.length,
    [activeMyBookings],
  );
  const startMs = start.getTime();
  const endMs = end.getTime();
  const bookingRanges = useMemo<Array<TimelineRange<AvailabilityBooking>>>(
    () =>
      dayBookings.map((booking) => ({
        item: booking,
        startMs: new Date(booking.start).getTime(),
        endMs: new Date(booking.end).getTime(),
      })),
    [dayBookings],
  );
  const blockRanges = useMemo<Array<TimelineRange<AvailabilityBlock>>>(
    () =>
      dayBlocks.map((block) => ({
        item: block,
        startMs: new Date(block.start).getTime(),
        endMs: new Date(block.end).getTime(),
      })),
    [dayBlocks],
  );
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
        ignoreBookingId: editingBookingId,
      }),
    [blockRanges, bookingRanges, editingBookingId, endMs, selectedDate, selectedTime, startMs],
  );

  const selectedOwnBooking = useMemo(
    () =>
      myBookings.find(
        (booking) =>
          isActiveBooking(booking) &&
          rangeMatches(start, end, booking.start, booking.end),
      ) ?? null,
    [end, myBookings, start],
  );
  const isConfirmedSelection = Boolean(selectedOwnBooking) && !editingBookingId;
  const ignoredBookingId = editingBookingId ?? selectedOwnBooking?.id ?? null;
  const selectedOwnSyncText = selectedOwnBooking
    ? syncLabel(selectedOwnBooking.outlookSyncStatus, selectedOwnBooking.status)
    : null;
  const selectedOwnSyncFailed = selectedOwnBooking?.outlookSyncStatus === "FAILED";
  const selectedOwnGuestWaiverLink = selectedOwnBooking
    ? selectedOwnBooking.guestWaiverUrl ?? guestWaiverLinks[selectedOwnBooking.id]
    : null;
  const selectedOwnMissingSignatures = selectedOwnBooking
    ? Math.max(0, selectedOwnBooking.playerCount - selectedOwnBooking.waiverSignedCount)
    : 0;
  const selectedOwnWaiverDelivery = selectedOwnBooking
    ? waiverDeliveryCopy(selectedOwnBooking.waiverEmailStatus)
    : null;
  const selectionConflict = useMemo(() => {
    const booking = findOverlappingTimelineItem(bookingRanges, startMs, endMs, ignoredBookingId);
    if (booking) return `Occupato da ${booking.organizerName}`;

    const block = findOverlappingTimelineItem(blockRanges, startMs, endMs);
    if (block) return `Bloccato: ${block.reason}`;

    return null;
  }, [blockRanges, bookingRanges, endMs, ignoredBookingId, startMs]);

  const loadAvailability = useCallback(async (date: string, signal?: AbortSignal) => {
    const response = await fetch(appPath(`/api/availability?date=${date}`), {
      cache: "no-store",
      signal,
    });

    if (!response.ok) {
      throw new Error(await readApiError(response));
    }

    setAvailability((await response.json()) as AvailabilityResponse);
  }, []);

  const loadAudit = useCallback(async (cursor?: string, signal?: AbortSignal) => {
    if (!isAdmin) return;

    const params = new URLSearchParams({ limit: String(adminAuditPageSize) });
    if (auditActionFilter !== "ALL") {
      params.set("action", auditActionFilter);
    }
    if (cursor) {
      params.set("cursor", cursor);
    }

    const response = await fetch(appPath(`/api/admin/audit?${params.toString()}`), { cache: "no-store", signal });
    if (!response.ok) {
      throw new Error(await readApiError(response));
    }

    // Stesso pattern cursore degli scarichi: senza cursore la pagina sostituisce, col cursore accoda.
    const json = (await response.json()) as { audit: AuditItem[]; nextCursor: string | null };
    setAudit((current) => (cursor ? [...current, ...json.audit] : json.audit));
    setAuditNextCursor(json.nextCursor);
  }, [auditActionFilter, isAdmin]);

  const loadStats = useCallback(async (signal?: AbortSignal) => {
    if (!isAdmin) return;

    const response = await fetch(appPath("/api/admin/stats"), { cache: "no-store", signal });
    if (!response.ok) {
      throw new Error(await readApiError(response));
    }

    const json = (await response.json()) as { stats: AdminStats };
    setStats(json.stats);
  }, [isAdmin]);

  const loadAdminWaivers = useCallback(async (cursor?: string, signal?: AbortSignal) => {
    if (!isAdmin) return;

    const params = new URLSearchParams({ limit: String(adminWaiverPageSize) });
    if (adminWaiverStatusFilter !== "ALL") {
      params.set("status", adminWaiverStatusFilter);
    }
    if (adminWaiverRoleFilter !== "ALL") {
      params.set("role", adminWaiverRoleFilter);
    }
    if (adminWaiverQuery.trim()) {
      params.set("query", adminWaiverQuery.trim());
    }
    if (cursor) {
      params.set("cursor", cursor);
    }

    const response = await fetch(appPath(`/api/admin/waivers?${params.toString()}`), { cache: "no-store", signal });
    if (!response.ok) {
      throw new Error(await readApiError(response));
    }

    const json = (await response.json()) as { waivers: AdminWaiverItem[]; nextCursor: string | null };
    setAdminWaivers((current) => (cursor ? [...current, ...json.waivers] : json.waivers));
    setAdminWaiverNextCursor(json.nextCursor);
  }, [adminWaiverQuery, adminWaiverRoleFilter, adminWaiverStatusFilter, isAdmin]);

  const loadMyBookings = useCallback(async (tokens: string[], signal?: AbortSignal) => {
    if (!tokens.length) {
      setMyBookings([]);
      return;
    }

    const response = await fetch(appPath("/api/bookings/lookup"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokens }),
      signal,
    });

    if (!response.ok) {
      throw new Error(await readApiError(response));
    }

    const json = (await response.json()) as { bookings: MyBooking[] };
    setMyBookings(json.bookings);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setLocalTokens(readStoredTokens());
      setGuestWaiverLinks(readStoredGuestWaiverLinks());
      setStorageReady(true);
    }, 0);

    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (availability?.date === selectedDate) return;

    const controller = new AbortController();

    queueMicrotask(() => {
      if (controller.signal.aborted) return;

      loadAvailability(selectedDate, controller.signal)
        .catch((error) => {
          if (controller.signal.aborted) return;
          setNotice({
            type: "error",
            text: errorText(error, "Impossibile caricare il calendario."),
          });
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setIsAvailabilityLoading(false);
          }
        });
    });

    return () => controller.abort();
  }, [availability?.date, loadAvailability, selectedDate]);

  useEffect(() => {
    if (!storageReady) return;

    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;

      setIsMyBookingsLoading(true);
      loadMyBookings(localTokens, controller.signal)
        .catch((error) => {
          if (controller.signal.aborted) return;
          setNotice({
            type: "warning",
            text: errorText(error, "Impossibile caricare le tue prenotazioni."),
          });
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setIsMyBookingsLoading(false);
          }
        });
    });

    return () => controller.abort();
  }, [loadMyBookings, localTokens, storageReady]);

  useEffect(() => {
    if (!isAdmin) return;

    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;

      setIsAuditLoading(true);
      loadAudit(undefined, controller.signal)
        .catch((error) => {
          if (controller.signal.aborted) return;
          setNotice({
            type: "warning",
            text: errorText(error, "Impossibile caricare il registro admin."),
          });
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setIsAuditLoading(false);
          }
        });
    });

    return () => controller.abort();
  }, [isAdmin, loadAudit]);

  useEffect(() => {
    if (!isAdmin) return;

    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;

      setIsStatsLoading(true);
      loadStats(controller.signal)
        .catch((error) => {
          if (controller.signal.aborted) return;
          setNotice({
            type: "warning",
            text: errorText(error, "Impossibile caricare le statistiche admin."),
          });
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setIsStatsLoading(false);
          }
        });
    });

    return () => controller.abort();
  }, [isAdmin, loadStats]);

  useEffect(() => {
    if (!isAdmin) return;

    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;

      setIsAdminWaiversLoading(true);
      loadAdminWaivers(undefined, controller.signal)
        .catch((error) => {
          if (controller.signal.aborted) return;
          setNotice({
            type: "warning",
            text: errorText(error, "Impossibile caricare gli scarichi responsabilita."),
          });
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setIsAdminWaiversLoading(false);
          }
        });
    });

    return () => controller.abort();
  }, [isAdmin, loadAdminWaivers]);

  useEffect(() => {
    const timeline = timelineRef.current;
    const selected = timeline?.querySelector<HTMLElement>("[data-selected='true']");

    if (!timeline || !selected) return;

    timeline.scrollTop = Math.max(
      0,
      selected.offsetTop - timeline.offsetTop - timeline.clientHeight / 2 + selected.clientHeight / 2,
    );
  }, [timelineSlots]);

  async function refresh(tokens = localTokens) {
    const refreshTasks = [
      (async () => {
        setIsAvailabilityLoading(true);
        try {
          await loadAvailability(selectedDate);
        } finally {
          setIsAvailabilityLoading(false);
        }
      })(),
      (async () => {
        setIsMyBookingsLoading(true);
        try {
          await loadMyBookings(tokens);
        } finally {
          setIsMyBookingsLoading(false);
        }
      })(),
    ];

    if (isAdmin) {
      refreshTasks.push(
        (async () => {
          setIsAuditLoading(true);
          try {
            await loadAudit();
          } finally {
            setIsAuditLoading(false);
          }
        })(),
        (async () => {
          setIsStatsLoading(true);
          try {
            await loadStats();
          } finally {
            setIsStatsLoading(false);
          }
        })(),
        (async () => {
          setIsAdminWaiversLoading(true);
          try {
            await loadAdminWaivers();
          } finally {
            setIsAdminWaiversLoading(false);
          }
        })(),
      );
    }

    const results = await Promise.allSettled(refreshTasks);
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");

    if (failed) {
      setNotice({
        type: "warning",
        text: errorText(failed.reason, "Aggiornamento incompleto. Riprova tra poco."),
      });
    }
  }

  async function loadMoreAudit() {
    if (!auditNextCursor) return;

    setIsAuditLoading(true);
    try {
      await loadAudit(auditNextCursor);
    } catch (error) {
      setNotice({
        type: "warning",
        text: errorText(error, "Impossibile caricare altro storico."),
      });
    } finally {
      setIsAuditLoading(false);
    }
  }

  async function loadMoreAdminWaivers() {
    if (!adminWaiverNextCursor) return;

    setIsAdminWaiversLoading(true);
    try {
      await loadAdminWaivers(adminWaiverNextCursor);
    } catch (error) {
      setNotice({
        type: "warning",
        text: errorText(error, "Impossibile caricare altri scarichi responsabilita."),
      });
    } finally {
      setIsAdminWaiversLoading(false);
    }
  }

  async function refreshAdminWaivers() {
    setIsAdminWaiversLoading(true);
    try {
      await loadAdminWaivers();
    } catch (error) {
      setNotice({
        type: "warning",
        text: errorText(error, "Impossibile aggiornare gli scarichi responsabilita."),
      });
    } finally {
      setIsAdminWaiversLoading(false);
    }
  }

  function rememberGuestWaiverLink(bookingId: string, link: string) {
    const nextLinks = { ...guestWaiverLinks, [bookingId]: link };
    writeStoredGuestWaiverLinks(nextLinks);
    setGuestWaiverLinks(nextLinks);
    return nextLinks;
  }

  function getGuestShareLink(link: string) {
    if (typeof window === "undefined") return link;
    return buildShortGuestWaiverLink(link, window.location.origin);
  }

  async function writeClipboardText(text: string) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // Fall through to the textarea fallback below.
      }
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();

    try {
      return document.execCommand("copy");
    } finally {
      document.body.removeChild(textarea);
    }
  }

  async function copyGuestWaiverLink(link: string) {
    const normalizedLink = getGuestShareLink(link);
    const copied = await writeClipboardText(normalizedLink);

    if (copied) {
      setCopiedGuestWaiverLink(normalizedLink);
      setNotice({ type: "success", text: "Link firma ospiti copiato." });
      window.setTimeout(() => {
        setCopiedGuestWaiverLink((current) => (current === normalizedLink ? null : current));
      }, 4500);
    } else {
      setNotice({
        type: "warning",
        text: "Copia automatica non riuscita. Apri il link e copialo dalla barra indirizzi.",
      });
    }
  }

  async function saveBooking() {
    setNotice(null);

    if (!editingBookingId) {
      return;
    }

    const body = {
      start: start.toISOString(),
      end: end.toISOString(),
      manageToken: editingToken ?? undefined,
    };

    try {
      const response = await fetch(appPath(`/api/bookings/${editingBookingId}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        setNotice({ type: "error", text: await readApiError(response) });
        return;
      }

      const json = (await response.json()) as { booking: MyBooking };

      if (json.booking.guestWaiverUrl) {
        rememberGuestWaiverLink(json.booking.id, json.booking.guestWaiverUrl);
      }

      setEditingBookingId(null);
      setEditingToken(null);
      setNotice(
        json.booking.status === "PENDING_SIGNATURES"
          ? null
          : {
              type: json.booking.outlookSyncStatus === "FAILED" ? "warning" : "success",
              text: bookingSuccessText(json.booking.outlookSyncStatus),
            },
      );
      await refresh();
    } catch {
      setNotice({ type: "error", text: networkErrorText });
    }
  }

  async function cancelBooking(booking: MyBooking | AvailabilityBooking) {
    const manageToken = "manageToken" in booking ? booking.manageToken : undefined;

    if (!isAdmin && !manageToken) {
      setNotice({ type: "error", text: "Apri il link ricevuto via email per cancellare questa prenotazione." });
      return;
    }

    if (!window.confirm("Vuoi cancellare questa prenotazione?")) {
      return;
    }

    try {
      const response = await fetch(appPath(`/api/bookings/${booking.id}`), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manageToken }),
      });

      if (!response.ok) {
        setNotice({ type: "error", text: await readApiError(response) });
        return;
      }

      const json = (await response.json()) as { booking: MyBooking };
      setNotice({ type: "info", text: cancellationSuccessText(json.booking.outlookSyncStatus) });
      await refresh();
    } catch {
      setNotice({ type: "error", text: networkErrorText });
    }
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
    setNotice({ type: "info", text: "Modifica gli orari e salva." });
  }

  async function retryWaiverEmail(signatureId: string) {
    try {
      const response = await fetch(appPath(`/api/admin/waivers/${signatureId}/retry-email`), {
        method: "POST",
      });

      if (!response.ok) {
        setNotice({ type: "error", text: await readApiError(response) });
        return;
      }

      setNotice({ type: "success", text: "Invio PDF ritentato." });
      await refreshAdminWaivers();
    } catch {
      setNotice({ type: "error", text: networkErrorText });
    }
  }

  const canPressPrimary = !selectionConflict && !isAvailabilityBusy && !isConfirmedSelection;
  const closeBookingWizard = () => {
    setEditingBookingId(null);
    setEditingToken(null);
    setNotice(null);
  };
  const openBookingCheckout = () => {
    const params = new URLSearchParams({
      date: selectedDate,
      time: selectedTime,
      duration: String(duration),
    });

    window.location.assign(appPath(`/book?${params.toString()}`));
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <Image
            src={appPath("/topfly-logo.png")}
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
            onClick={() => signOut({ callbackUrl: appPath("/signin") })}
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
            <div className="date-strip" role="group" aria-label="Giorni disponibili">
              {dates.map((date) => {
                const key = dateKey(date);
                return (
                  <button
                    className={`date-chip ${key === selectedDate ? "active" : ""}`}
                    key={key}
                    onClick={() => setSelectedDate(key)}
                    aria-pressed={key === selectedDate}
                    type="button"
                  >
                    <span>{humanDay(date, initialState.dateKeys[0], initialState.dateKeys[1])}</span>
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
              {isAvailabilityBusy ? <span className="loading-pill">Aggiorno</span> : null}
            </div>

            <BookingTimeGrid
              durationOptions={durationOptions}
              duration={duration}
              onDurationChange={setDuration}
              slots={timelineSlots}
              onSelectTime={setSelectedTime}
              timelineAriaLabel="Disponibilita del giorno"
              timelineRef={timelineRef}
              markPending
              trackSelected
              busyLabel={(booking) =>
                booking.status === "PENDING_SIGNATURES" ? "Attesa firme" : booking.organizerName
              }
              busyTitle={(booking) => `${bookingStatusLabel(booking.status)} - ${booking.organizerName}`}
            />
          </section>
        </div>

        <aside className="side-stack">
          <section className="summary-card">
            {selectedOwnBooking && isConfirmedSelection ? (
              <div className="confirmed-summary">
                <p className="muted-label">Riepilogo</p>
                <div className={`summary-state ${selectedOwnSyncFailed ? "sync-warning" : ""}`}>
                  <span
                    className={`summary-state-icon ${
                      selectedOwnBooking.status === "PENDING_SIGNATURES" || selectedOwnSyncFailed
                        ? "warning"
                        : "success"
                    }`}
                  >
                    {selectedOwnBooking.status === "PENDING_SIGNATURES" || selectedOwnSyncFailed ? (
                      <MailWarning size={17} />
                    ) : (
                      <Check size={17} />
                    )}
                  </span>
                  <div>
                    <h2>
                      {selectedOwnBooking.status === "PENDING_SIGNATURES"
                        ? "Prenotazione selezionata"
                        : bookingStatusLabel(selectedOwnBooking.status)}
                    </h2>
                    <p>
                      {localSummaryDay(start)} · {localTime(start)} - {localTime(end)}
                    </p>
                    {selectedOwnBooking.status !== "PENDING_SIGNATURES" && selectedOwnSyncText ? (
                      <small className={selectedOwnSyncFailed ? "sync-warning-text" : undefined}>
                        {selectedOwnSyncFailed
                          ? `${selectedOwnSyncText}. La prenotazione resta valida.`
                          : selectedOwnSyncText}
                      </small>
                    ) : null}
                    {selectedOwnBooking.status !== "PENDING_SIGNATURES" ? (
                      <small>
                        Firme scarico: {selectedOwnBooking.waiverSignedCount}/{selectedOwnBooking.playerCount}
                      </small>
                    ) : null}
                  </div>
                </div>
                {selectedOwnBooking.status === "PENDING_SIGNATURES" ? (
                  <PendingSignaturePanel
                    missingSignatures={selectedOwnMissingSignatures}
                    signatureDeadlineAt={selectedOwnBooking.signatureDeadlineAt}
                    guestWaiverLink={selectedOwnGuestWaiverLink ?? null}
                    linkCopied={
                      selectedOwnGuestWaiverLink
                        ? copiedGuestWaiverLink === getGuestShareLink(selectedOwnGuestWaiverLink)
                        : false
                    }
                    onCopyLink={copyGuestWaiverLink}
                    footnote={
                      selectedOwnWaiverDelivery
                        ? {
                            success: selectedOwnWaiverDelivery.tone === "success",
                            text: selectedOwnWaiverDelivery.title,
                          }
                        : null
                    }
                  />
                ) : null}
                {notice ? (
                  <div
                    aria-live={notice.type === "error" ? "assertive" : "polite"}
                    className={`notice ${notice.type}`}
                    role={notice.type === "error" ? "alert" : "status"}
                  >
                    {notice.text}
                  </div>
                ) : null}
                {selectedOwnWaiverDelivery && selectedOwnBooking.status !== "PENDING_SIGNATURES" ? (
                  <div className={`official-pdf-panel ${selectedOwnWaiverDelivery.tone}`}>
                    <FileText size={17} />
                    <div>
                      <strong>{selectedOwnWaiverDelivery.title}</strong>
                      <small>{selectedOwnWaiverDelivery.text}</small>
                    </div>
                  </div>
                ) : null}
                {selectedOwnGuestWaiverLink && selectedOwnBooking.status !== "PENDING_SIGNATURES" ? (
                  <GuestLinkPanel
                    copied={copiedGuestWaiverLink === getGuestShareLink(selectedOwnGuestWaiverLink)}
                    link={selectedOwnGuestWaiverLink}
                    onCopy={copyGuestWaiverLink}
                  />
                ) : null}
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
            ) : (
              <>
                <div className="summary-top">
                  <div>
                    <p className="muted-label">Riepilogo</p>
                    <h2>{selectionConflict ? "Slot non disponibile" : localSummaryDay(start)}</h2>
                  </div>
                  {selectionConflict ? null : <span className="summary-duration">{durationLabel(duration)}</span>}
                </div>
                <p className="summary-time">
                  {selectionConflict
                    ? `${localSummaryDay(start)} · ${localTime(start)} - ${localTime(end)}`
                    : `${localTime(start)} - ${localTime(end)}`}
                </p>

                {selectionConflict ? (
                  <div className="notice error" role="alert" aria-live="assertive">{selectionConflict}</div>
                ) : notice ? (
                  <div
                    aria-live={notice.type === "error" ? "assertive" : "polite"}
                    className={`notice ${notice.type}`}
                    role={notice.type === "error" ? "alert" : "status"}
                  >
                    {notice.text}
                  </div>
                ) : null}

              </>
            )}
            {isConfirmedSelection || selectionConflict ? null : (
              <>
                <button
                  className="primary-button full-width"
                  disabled={!canPressPrimary}
                  onClick={editingBookingId ? saveBooking : openBookingCheckout}
                  type="button"
                >
                  {editingBookingId ? <Check size={16} /> : null}
                  {editingBookingId ? "Salva modifica" : "Prenota e firma"}
                </button>
                {editingBookingId ? null : (
                  <p className="summary-action-note">
                    Puoi prenotare anche per allenarti in autonomia. Se ci sono ospiti, senza tutte le firme la prenotazione viene annullata.
                  </p>
                )}
              </>
            )}

            {editingBookingId ? (
              <button
                className="ghost-button full-width"
                onClick={closeBookingWizard}
                type="button"
              >
                Annulla
              </button>
            ) : null}
          </section>

          <MyBookingsSection
            bookings={activeMyBookings}
            count={activeMyBookingCount}
            isLoading={isMyBookingsLoading}
            guestWaiverLinks={guestWaiverLinks}
            selectedBookingId={selectedOwnBooking?.id ?? null}
            onCopyGuestLink={copyGuestWaiverLink}
            onEdit={editBooking}
            onCancel={cancelBooking}
          />

          {isAdmin ? (
            <AdminPanel
              isAdminLoading={isAdminLoading}
              options={options}
              selectedDate={selectedDate}
              dayBlocks={dayBlocks}
              onRefresh={refresh}
              setNotice={setNotice}
              dayBookings={dayBookings}
              onEditBooking={editBooking}
              onCancelBooking={cancelBooking}
              adminWaivers={adminWaivers}
              adminWaiverStatusFilter={adminWaiverStatusFilter}
              onWaiverStatusFilterChange={setAdminWaiverStatusFilter}
              adminWaiverRoleFilter={adminWaiverRoleFilter}
              onWaiverRoleFilterChange={setAdminWaiverRoleFilter}
              adminWaiverQuery={adminWaiverQuery}
              onWaiverQueryChange={setAdminWaiverQuery}
              isAdminWaiversLoading={isAdminWaiversLoading}
              adminWaiverNextCursor={adminWaiverNextCursor}
              onLoadMoreWaivers={loadMoreAdminWaivers}
              onRetryWaiver={retryWaiverEmail}
              stats={stats}
              isStatsLoading={isStatsLoading}
              audit={audit}
              auditActionFilter={auditActionFilter}
              onAuditActionFilterChange={setAuditActionFilter}
              isAuditLoading={isAuditLoading}
              auditNextCursor={auditNextCursor}
              onLoadMoreAudit={loadMoreAudit}
            />
          ) : null}
        </aside>
      </section>
    </main>
  );
}
