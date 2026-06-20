"use client";

import {
  CalendarDays,
  Check,
  Clock3,
  Copy,
  Download,
  Edit3,
  FileText,
  Lock,
  LogOut,
  MailWarning,
  RotateCcw,
  Shield,
  Trash2,
} from "lucide-react";
import Image from "next/image";
import { signOut } from "next-auth/react";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { appPath } from "@/lib/app-path";
import { birthDateInputToIsoDate } from "@/lib/birth-date-input";
import { bookingDurationOptions } from "@/lib/booking-constants";
import { isExternalEmailForDomain, isValidEmail, normalizeEmailInput } from "@/lib/email";
import { buildShortGuestWaiverLink } from "@/lib/guest-waiver-link";
import type { BookingInitialState } from "@/lib/booking-initial-state";
import type {
  AuditItem,
  AvailabilityBlock,
  AvailabilityBooking,
  CurrentUser,
  MyBooking,
} from "@/lib/types";
import { GuestLinkPanel } from "@/components/guest-link-panel";
import {
  WaiverFormSection,
  type WaiverField,
  type WaiverFormValue,
} from "@/components/waiver-form-section";

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
  type: "success" | "error" | "info" | "warning";
  text: string;
};

type GuestWaiverLinks = Record<string, string>;
type FormField = "organizerName" | "organizerEmail" | "playerCount" | WaiverField;

type AdminWaiverItem = {
  id: string;
  bookingId: string;
  bookingRevision: number;
  signerRole: "ORGANIZER" | "GUEST";
  signerName: string;
  signerEmail: string;
  signedAt: string;
  status: "ACTIVE" | "CANCELED";
  emailStatus: "PENDING" | "SENT" | "FAILED" | "SKIPPED";
  emailError: string | null;
  guestEmailStatus: "PENDING" | "SENT" | "FAILED" | "SKIPPED";
  guestEmailError: string | null;
  bookingStart: string;
  bookingEnd: string;
  playerCount: number;
};

const tokenStorageKey = "topfly-padel.tokens.v1";
const guestWaiverLinksStorageKey = "topfly-padel.guest-waiver-links.v1";
const adminWaiverPageSize = 50;
const fallbackInitialState: BookingInitialState = {
  date: "1970-01-01",
  time: "18:00",
  dateKeys: ["1970-01-01"],
};
const emptyWaiverForm: WaiverFormValue = {
  birthDate: "",
  birthPlace: "",
  isAdultConfirmed: false,
  privacyAccepted: false,
  regulationAccepted: false,
  liabilityAccepted: false,
  specificApprovalAccepted: false,
  signatureImageDataUrl: "",
};

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

function durationLabel(minutes: number) {
  if (minutes === 60) return "1 ora";
  if (minutes % 60 === 0) return `${minutes / 60} ore`;
  return `${minutes} min`;
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

function rangeMatches(start: Date, end: Date, itemStart: string, itemEnd: string) {
  return start.getTime() === new Date(itemStart).getTime() && end.getTime() === new Date(itemEnd).getTime();
}

async function readApiError(response: Response) {
  const json = (await response.json().catch(() => null)) as { error?: string } | null;
  return json?.error ?? "Richiesta non riuscita.";
}

function syncLabel(status: string, bookingStatus?: string) {
  const isCanceled = bookingStatus === "CANCELED";

  if (status === "SYNCED") {
    return isCanceled ? "Cancellazione Outlook inviata" : "Invito Outlook inviato";
  }
  if (status === "FAILED") {
    return isCanceled ? "Cancellazione Outlook non riuscita" : "Email non inviata";
  }
  if (status === "PENDING") {
    return isCanceled ? "Cancellazione Outlook in preparazione" : "Invito Outlook in preparazione";
  }
  return null;
}

function bookingSuccessText(status: string) {
  if (status === "SYNCED") return "Fatto. Prenotazione confermata con invito Outlook.";
  if (status === "FAILED") return "Prenotazione confermata, ma l'invito Outlook non e' stato inviato.";
  return "Fatto. Prenotazione confermata.";
}

function cancellationSuccessText(status: string) {
  if (status === "SYNCED") return "Prenotazione cancellata. Cancellazione Outlook inviata.";
  if (status === "FAILED") return "Prenotazione cancellata. Cancellazione Outlook non riuscita.";
  return "Prenotazione cancellata.";
}

function waiverEmailStatusLabel(status: AdminWaiverItem["emailStatus"]) {
  if (status === "SENT") return "Inviata";
  if (status === "FAILED") return "Da reinviare";
  if (status === "SKIPPED") return "Non configurata";
  return "In coda";
}

function waiverEmailStatusTone(status: AdminWaiverItem["emailStatus"]) {
  if (status === "SENT") return "success";
  if (status === "FAILED") return "danger";
  if (status === "SKIPPED") return "neutral";
  return "warning";
}

function waiverSignatureStatusLabel(status: AdminWaiverItem["status"]) {
  return status === "ACTIVE" ? "Attiva" : "Rinunciata";
}

function waiverSignatureStatusTone(status: AdminWaiverItem["status"]) {
  return status === "ACTIVE" ? "success" : "neutral";
}

function waiverDeliveryCopy(status: AdminWaiverItem["emailStatus"] | null) {
  if (status === "SENT") {
    return {
      tone: "success",
      title: "Modulo ufficiale inviato alla Direzione",
      text: "Il PDF e' stato compilato, archiviato e inviato alla mailbox Padel.",
    };
  }

  if (status === "FAILED") {
    return {
      tone: "warning",
      title: "PDF salvato, email da reinviare",
      text: "La firma resta registrata. Il PDF si puo' scaricare o reinviare da admin.",
    };
  }

  if (status === "SKIPPED") {
    return {
      tone: "warning",
      title: "PDF salvato in archivio",
      text: "L'invio email non e' configurato: il modulo resta disponibile nell'admin.",
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

function writeStoredTokens(tokens: string[]) {
  window.localStorage.setItem(tokenStorageKey, JSON.stringify(tokens.slice(0, 30)));
}

function writeStoredGuestWaiverLinks(links: GuestWaiverLinks) {
  window.localStorage.setItem(guestWaiverLinksStorageKey, JSON.stringify(links));
}

export function BookingApp({
  adminMode = false,
  initialState = fallbackInitialState,
  initialUser,
}: {
  adminMode?: boolean;
  initialState?: BookingInitialState;
  initialUser?: CurrentUser;
}) {
  const isAdmin = adminMode && initialUser?.role === "ADMIN";
  const [selectedDate, setSelectedDate] = useState(initialState.date);
  const [selectedTime, setSelectedTime] = useState(initialState.time);
  const [duration, setDuration] = useState(60);
  const [availability, setAvailability] = useState<AvailabilityResponse | null>(null);
  const [myBookings, setMyBookings] = useState<MyBooking[]>([]);
  const [audit, setAudit] = useState<AuditItem[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [editingBookingId, setEditingBookingId] = useState<string | null>(null);
  const [editingToken, setEditingToken] = useState<string | null>(null);
  const [isBookingFormOpen, setIsBookingFormOpen] = useState(false);
  const [bookingFormStep, setBookingFormStep] = useState<1 | 2>(1);
  const [organizerName, setOrganizerName] = useState("");
  const [organizerEmail, setOrganizerEmail] = useState("");
  const [playerCount, setPlayerCount] = useState(4);
  const [waiverForm, setWaiverForm] = useState<WaiverFormValue>(emptyWaiverForm);
  const [touchedFields, setTouchedFields] = useState<Partial<Record<FormField, boolean>>>({});
  const [bookingSubmitAttempted, setBookingSubmitAttempted] = useState(false);
  const [localTokens, setLocalTokens] = useState<string[]>([]);
  const [guestWaiverLinks, setGuestWaiverLinks] = useState<GuestWaiverLinks>({});
  const [copiedGuestWaiverLink, setCopiedGuestWaiverLink] = useState<string | null>(null);
  const [adminWaivers, setAdminWaivers] = useState<AdminWaiverItem[]>([]);
  const [adminWaiverStatusFilter, setAdminWaiverStatusFilter] = useState<AdminWaiverItem["emailStatus"] | "ALL">("ALL");
  const [adminWaiverRoleFilter, setAdminWaiverRoleFilter] = useState<AdminWaiverItem["signerRole"] | "ALL">("ALL");
  const [adminWaiverQuery, setAdminWaiverQuery] = useState("");
  const [adminWaiverNextCursor, setAdminWaiverNextCursor] = useState<string | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [blockStart, setBlockStart] = useState("09:00");
  const [blockEnd, setBlockEnd] = useState("10:00");
  const [blockReason, setBlockReason] = useState("Manutenzione");
  const [isPending, startTransition] = useTransition();
  const timelineRef = useRef<HTMLDivElement | null>(null);

  const dates = useMemo(
    () =>
      initialState.dateKeys.map((key) => dateTimeFromParts(key, "00:00")),
    [initialState.dateKeys],
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
  const activeMyBookings = useMemo(
    () => myBookings.filter((booking) => booking.status === "CONFIRMED"),
    [myBookings],
  );
  const activeMyBookingCount = useMemo(
    () => activeMyBookings.length,
    [activeMyBookings],
  );
  const allowedDomain = availability?.settings.allowedDomain ?? "azienda.it";
  const normalizedOrganizerEmail = normalizeEmailInput(organizerEmail);
  const isExternalEmail = isExternalEmailForDomain(normalizedOrganizerEmail, allowedDomain);
  const birthDateIso = birthDateInputToIsoDate(waiverForm.birthDate);
  const isWaiverFormValid =
    playerCount >= 2 &&
    playerCount <= 4 &&
    Boolean(birthDateIso) &&
    waiverForm.birthPlace.trim().length > 1 &&
    waiverForm.isAdultConfirmed &&
    waiverForm.privacyAccepted &&
    waiverForm.regulationAccepted &&
    waiverForm.liabilityAccepted &&
    waiverForm.specificApprovalAccepted &&
    Boolean(waiverForm.signatureImageDataUrl);
  const isBookingFormValid =
    !isBookingFormOpen ||
    (organizerName.trim().length > 1 && isValidEmail(normalizedOrganizerEmail) && isWaiverFormValid);
  const isBookingDetailsValid =
    organizerName.trim().length > 1 &&
    isValidEmail(normalizedOrganizerEmail) &&
    playerCount >= 2 &&
    playerCount <= 4;

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
  const selectedOwnSyncText = selectedOwnBooking
    ? syncLabel(selectedOwnBooking.outlookSyncStatus, selectedOwnBooking.status)
    : null;
  const selectedOwnSyncFailed = selectedOwnBooking?.outlookSyncStatus === "FAILED";
  const selectedOwnGuestWaiverLink = selectedOwnBooking
    ? selectedOwnBooking.guestWaiverUrl ?? guestWaiverLinks[selectedOwnBooking.id]
    : null;
  const selectedOwnWaiverDelivery = selectedOwnBooking
    ? waiverDeliveryCopy(selectedOwnBooking.waiverEmailStatus)
    : null;
  const missingBookingFields = useMemo(() => {
    const missing: string[] = [];
    if (organizerName.trim().length < 2) missing.push("nome referente");
    if (!isValidEmail(normalizedOrganizerEmail)) missing.push("email valida");
    if (!birthDateIso) missing.push("data di nascita");
    if (waiverForm.birthPlace.trim().length < 2) missing.push("luogo di nascita");
    if (!waiverForm.isAdultConfirmed) missing.push("maggiore eta");
    if (!waiverForm.privacyAccepted) missing.push("privacy");
    if (!waiverForm.regulationAccepted) missing.push("regolamento");
    if (!waiverForm.liabilityAccepted) missing.push("responsabilita");
    if (!waiverForm.specificApprovalAccepted) missing.push("clausole specifiche");
    if (!waiverForm.signatureImageDataUrl) missing.push("firma nel riquadro");
    return missing;
  }, [
    birthDateIso,
    normalizedOrganizerEmail,
    organizerName,
    waiverForm.birthPlace,
    waiverForm.isAdultConfirmed,
    waiverForm.liabilityAccepted,
    waiverForm.privacyAccepted,
    waiverForm.regulationAccepted,
    waiverForm.signatureImageDataUrl,
    waiverForm.specificApprovalAccepted,
  ]);

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
    const response = await fetch(appPath(`/api/availability?date=${selectedDate}`), {
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(await readApiError(response));
    }

    setAvailability((await response.json()) as AvailabilityResponse);
  }, [selectedDate]);

  const loadAudit = useCallback(async () => {
    if (!isAdmin) return;

    const response = await fetch(appPath("/api/admin/audit"), { cache: "no-store" });
    if (response.ok) {
      const json = (await response.json()) as { audit: AuditItem[] };
      setAudit(json.audit);
    }
  }, [isAdmin]);

  const loadAdminWaivers = useCallback(async (cursor?: string) => {
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

    const response = await fetch(appPath(`/api/admin/waivers?${params.toString()}`), { cache: "no-store" });
    if (response.ok) {
      const json = (await response.json()) as { waivers: AdminWaiverItem[]; nextCursor: string | null };
      setAdminWaivers((current) => (cursor ? [...current, ...json.waivers] : json.waivers));
      setAdminWaiverNextCursor(json.nextCursor);
    }
  }, [adminWaiverQuery, adminWaiverRoleFilter, adminWaiverStatusFilter, isAdmin]);

  const loadMyBookings = useCallback(async (tokens: string[]) => {
    if (!tokens.length) {
      setMyBookings([]);
      return;
    }

    const response = await fetch(appPath("/api/bookings/lookup"), {
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
      setLocalTokens(readStoredTokens());
      setGuestWaiverLinks(readStoredGuestWaiverLinks());
      setStorageReady(true);
    }, 0);

    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    startTransition(async () => {
      try {
        await loadAvailability();
        await loadAudit();
        await loadAdminWaivers();
      } catch (error) {
        setNotice({
          type: "error",
          text: error instanceof Error ? error.message : "Impossibile caricare il calendario.",
        });
      }
    });
  }, [loadAdminWaivers, loadAudit, loadAvailability]);

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
    await loadAdminWaivers();
    await loadMyBookings(tokens);
  }

  function rememberToken(token: string) {
    const nextTokens = [token, ...localTokens.filter((item) => item !== token)].slice(0, 30);
    writeStoredTokens(nextTokens);
    setLocalTokens(nextTokens);
    return nextTokens;
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

    if (!editingBookingId && !isBookingFormOpen) {
      setIsBookingFormOpen(true);
      setBookingFormStep(1);
      setBookingSubmitAttempted(false);
      return;
    }

    if (!editingBookingId && !isBookingDetailsValid) {
      setBookingFormStep(1);
      setBookingSubmitAttempted(true);
      setNotice({ type: "warning", text: "Completa i dati della prenotazione prima di continuare." });
      return;
    }

    if (!editingBookingId && !isBookingFormValid) {
      setBookingFormStep(2);
      setBookingSubmitAttempted(true);
      setNotice({ type: "warning", text: "Completa i campi obbligatori prima di prenotare." });
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
          organizerEmail: normalizedOrganizerEmail,
          playerCount,
          waiver: {
            birthDate: birthDateIso,
            birthPlace: waiverForm.birthPlace,
            isAdultConfirmed: waiverForm.isAdultConfirmed,
            privacyAccepted: waiverForm.privacyAccepted,
            regulationAccepted: waiverForm.regulationAccepted,
            liabilityAccepted: waiverForm.liabilityAccepted,
            specificApprovalAccepted: waiverForm.specificApprovalAccepted,
            signatureImageDataUrl: waiverForm.signatureImageDataUrl,
          },
        };

    const response = await fetch(appPath(isEditing ? `/api/bookings/${editingBookingId}` : "/api/bookings"), {
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
      if (json.booking.manageToken) {
        nextTokens = rememberToken(json.booking.manageToken);
      }
    }

    if (json.booking.guestWaiverUrl) {
      rememberGuestWaiverLink(json.booking.id, json.booking.guestWaiverUrl);
    }

    setEditingBookingId(null);
    setEditingToken(null);
    setIsBookingFormOpen(false);
    setBookingFormStep(1);
    setBookingSubmitAttempted(false);
    setTouchedFields({});
    if (!isEditing) {
      setWaiverForm(emptyWaiverForm);
      setOrganizerName("");
      setOrganizerEmail("");
      setPlayerCount(4);
    }
    setNotice({
      type: json.booking.outlookSyncStatus === "FAILED" ? "warning" : "success",
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

    if (!window.confirm("Vuoi cancellare questa prenotazione?")) {
      return;
    }

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
    const response = await fetch(appPath("/api/admin/blocks"), {
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
    if (!window.confirm("Vuoi rimuovere questo blocco admin?")) {
      return;
    }

    const response = await fetch(appPath(`/api/admin/blocks/${id}`), { method: "DELETE" });

    if (!response.ok) {
      setNotice({ type: "error", text: await readApiError(response) });
      return;
    }

    setNotice({ type: "info", text: "Blocco rimosso." });
    await refresh();
  }

  async function retryWaiverEmail(signatureId: string) {
    const response = await fetch(appPath(`/api/admin/waivers/${signatureId}/retry-email`), {
      method: "POST",
    });

    if (!response.ok) {
      setNotice({ type: "error", text: await readApiError(response) });
      return;
    }

    setNotice({ type: "success", text: "Invio PDF ritentato." });
    await refresh();
  }

  const canSave = !selectionConflict && !isPending && !isConfirmedSelection && isBookingFormValid;
  const canPressPrimary = !selectionConflict && !isPending && !isConfirmedSelection;
  const showFieldError = (field: FormField, invalid: boolean) =>
    invalid && (bookingSubmitAttempted || Boolean(touchedFields[field]));
  const markTouched = (field: FormField) => {
    setTouchedFields((current) => ({ ...current, [field]: true }));
  };
  const closeBookingWizard = () => {
    setEditingBookingId(null);
    setEditingToken(null);
    setIsBookingFormOpen(false);
    setBookingFormStep(1);
    setBookingSubmitAttempted(false);
    setTouchedFields({});
    setNotice(null);
  };
  const continueBookingWizard = () => {
    if (!isBookingDetailsValid) {
      setBookingSubmitAttempted(true);
      setNotice({ type: "warning", text: "Completa nome, email e numero giocatori." });
      return;
    }

    setNotice(null);
    setBookingFormStep(2);
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
              {isPending ? <span className="loading-pill">Aggiorno</span> : null}
            </div>

            <div className="booking-controls">
              <div>
                <div className="control-heading">
                  <span>Durata</span>
                </div>
                <div className="duration-row" role="group" aria-label="Durata prenotazione">
                  {durationOptions.map((minutes) => (
                    <button
                      className={`duration-chip ${duration === minutes ? "active" : ""}`}
                      key={minutes}
                      onClick={() => setDuration(minutes)}
                      aria-pressed={duration === minutes}
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

            <div className="timeline" role="group" aria-label="Disponibilita del giorno" ref={timelineRef}>
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
            {selectedOwnBooking && isConfirmedSelection ? (
              <div className="confirmed-summary">
                <p className="muted-label">Riepilogo</p>
                <div className={`summary-state ${selectedOwnSyncFailed ? "sync-warning" : ""}`}>
                  <span className={`summary-state-icon ${selectedOwnSyncFailed ? "warning" : "success"}`}>
                    {selectedOwnSyncFailed ? <MailWarning size={17} /> : <Check size={17} />}
                  </span>
                  <div>
                    <h2>Prenotazione confermata</h2>
                    <p>
                      {localSummaryDay(start)} · {localTime(start)} - {localTime(end)}
                    </p>
                    {selectedOwnSyncText ? (
                      <small className={selectedOwnSyncFailed ? "sync-warning-text" : undefined}>
                        {selectedOwnSyncFailed
                          ? `${selectedOwnSyncText}. La prenotazione resta valida.`
                          : selectedOwnSyncText}
                      </small>
                    ) : null}
                    <small>
                      Firme scarico: {selectedOwnBooking.waiverSignedCount}/{selectedOwnBooking.playerCount}
                    </small>
                  </div>
                </div>
                {notice ? (
                  <div
                    aria-live={notice.type === "error" ? "assertive" : "polite"}
                    className={`notice ${notice.type}`}
                    role={notice.type === "error" ? "alert" : "status"}
                  >
                    {notice.text}
                  </div>
                ) : null}
                {selectedOwnWaiverDelivery ? (
                  <div className={`official-pdf-panel ${selectedOwnWaiverDelivery.tone}`}>
                    <FileText size={17} />
                    <div>
                      <strong>{selectedOwnWaiverDelivery.title}</strong>
                      <small>{selectedOwnWaiverDelivery.text}</small>
                    </div>
                  </div>
                ) : null}
                {selectedOwnGuestWaiverLink ? (
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
                  <div className="notice error">{selectionConflict}</div>
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
                  disabled={!canPressPrimary || (editingBookingId ? !canSave : false)}
                  onClick={editingBookingId ? saveBooking : openBookingCheckout}
                  type="button"
                >
                  {editingBookingId ? <Check size={16} /> : null}
                  {editingBookingId ? "Salva modifica" : "Prenota e firma"}
                </button>
                {editingBookingId ? null : (
                  <p className="summary-action-note">
                    Ricevi conferma via email. Scarico inviato all&apos;Amministrazione.
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

          <section className="panel">
            <div className="section-title spread">
              <span>Le mie prenotazioni</span>
              <span className="count-pill">{activeMyBookingCount}</span>
            </div>
            <div className="booking-list">
              {activeMyBookings.length ? (
                activeMyBookings.map((booking) => {
                  const guestLink = booking.guestWaiverUrl ?? guestWaiverLinks[booking.id];

                  return (
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
                          {syncLabel(booking.outlookSyncStatus, booking.status)
                            ? ` · ${syncLabel(booking.outlookSyncStatus, booking.status)}`
                            : ""}
                        </small>
                        <small>
                          Firme scarico: {booking.waiverSignedCount}/{booking.playerCount}
                        </small>
                      </div>
                      <div className="item-actions">
                        {guestLink ? (
                          <button
                            className="mini-button"
                            onClick={() => copyGuestWaiverLink(guestLink)}
                            type="button"
                            aria-label="Copia link firma ospiti"
                            title="Copia link firma ospiti"
                          >
                            <Copy size={15} />
                          </button>
                        ) : null}
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
                    </article>
                  );
                })
              ) : (
                <p className="empty-state">Nessuna prenotazione attiva salvata su questo dispositivo.</p>
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
                        <small>
                          Firme scarico: {booking.waiverSignedCount}/{booking.playerCount}
                          {booking.waiverEmailStatus === "FAILED" ? " · email PDF da reinviare" : ""}
                        </small>
                      </div>
                      <div className="item-actions">
                        <button
                          className="mini-button"
                          onClick={() => editBooking(booking)}
                          type="button"
                          aria-label={`Modifica prenotazione di ${booking.organizerName}`}
                          title="Modifica prenotazione"
                        >
                          <Edit3 size={15} />
                        </button>
                        <button
                          className="mini-button danger"
                          onClick={() => cancelBooking(booking)}
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

              <details>
                <summary>Scarichi responsabilita</summary>
                <div className="admin-filter-row">
                  <label>
                    Stato email PDF
                    <select
                      value={adminWaiverStatusFilter}
                      onChange={(event) => {
                        setAdminWaiverStatusFilter(event.target.value as AdminWaiverItem["emailStatus"] | "ALL");
                      }}
                    >
                      <option value="ALL">Tutti</option>
                      <option value="FAILED">Da reinviare</option>
                      <option value="PENDING">In coda</option>
                      <option value="SENT">Inviata</option>
                      <option value="SKIPPED">Non configurata</option>
                    </select>
                  </label>
                  <label>
                    Ruolo
                    <select
                      value={adminWaiverRoleFilter}
                      onChange={(event) =>
                        setAdminWaiverRoleFilter(event.target.value as AdminWaiverItem["signerRole"] | "ALL")
                      }
                    >
                      <option value="ALL">Tutti</option>
                      <option value="ORGANIZER">Referente</option>
                      <option value="GUEST">Ospite</option>
                    </select>
                  </label>
                  <label>
                    Cerca
                    <input
                      value={adminWaiverQuery}
                      onChange={(event) => setAdminWaiverQuery(event.target.value)}
                      placeholder="Nome o email"
                    />
                  </label>
                  <span className="count-pill">{adminWaivers.length}</span>
                </div>
                <div className="booking-list">
                  {adminWaivers.length ? (
                    <>
                      {adminWaivers.map((waiver) => (
                        <article className="booking-item" key={waiver.id}>
                          <div>
                            <strong>{waiver.signerName}</strong>
                            <span>
                              {waiver.signerRole === "ORGANIZER" ? "Referente" : "Ospite"} -{" "}
                              {localDay(new Date(waiver.bookingStart))}, {localTime(new Date(waiver.bookingStart))} -{" "}
                              {localTime(new Date(waiver.bookingEnd))}
                            </span>
                            <small>
                              <span className={`status-badge ${waiverSignatureStatusTone(waiver.status)}`}>
                                Firma {waiverSignatureStatusLabel(waiver.status)}
                              </span>{" "}
                              <span className={`status-badge ${waiverEmailStatusTone(waiver.emailStatus)}`}>
                                PDF Direzione {waiverEmailStatusLabel(waiver.emailStatus)}
                              </span>{" "}
                              {waiver.signerRole === "GUEST" ? (
                                <span className={`status-badge ${waiverEmailStatusTone(waiver.guestEmailStatus)}`}>
                                  Email ospite {waiverEmailStatusLabel(waiver.guestEmailStatus)}
                                </span>
                              ) : null}
                              {waiver.emailError ? ` - PDF: ${waiver.emailError.slice(0, 80)}` : ""}
                              {waiver.guestEmailError ? ` - Ospite: ${waiver.guestEmailError.slice(0, 80)}` : ""}
                            </small>
                          </div>
                          <div className="item-actions">
                            <a
                              className="mini-button"
                              href={appPath(`/api/admin/waivers/${waiver.id}/pdf`)}
                              aria-label={`Scarica PDF di ${waiver.signerName}`}
                              title="Scarica PDF"
                            >
                              <Download size={15} />
                            </a>
                            {waiver.emailStatus === "FAILED" || waiver.emailStatus === "SKIPPED" ? (
                              <button
                                className="mini-button"
                                onClick={() => retryWaiverEmail(waiver.id)}
                                type="button"
                                aria-label={`Reinvia PDF di ${waiver.signerName}`}
                                title="Reinvia PDF"
                              >
                                <RotateCcw size={15} />
                              </button>
                            ) : null}
                          </div>
                        </article>
                      ))}
                      {adminWaiverNextCursor ? (
                        <button
                          className="ghost-button full-width"
                          onClick={() => loadAdminWaivers(adminWaiverNextCursor)}
                          type="button"
                        >
                          Mostra altri
                        </button>
                      ) : null}
                    </>
                  ) : (
                    <p className="empty-state">Nessuno scarico corrisponde al filtro selezionato.</p>
                  )}
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

      {isBookingFormOpen && !editingBookingId ? (
        <div className="booking-wizard-backdrop" role="presentation">
          <section
            aria-labelledby="booking-wizard-title"
            aria-modal="true"
            className="booking-wizard"
            role="dialog"
          >
            <div className="booking-wizard-header">
              <div>
                <p className="muted-label">
                  {localSummaryDay(start)} · {localTime(start)} - {localTime(end)}
                </p>
                <h2 id="booking-wizard-title">
                  {bookingFormStep === 1 ? "Dati prenotazione" : "Firma accesso campo"}
                </h2>
              </div>
              <button
                className="mini-button"
                onClick={closeBookingWizard}
                type="button"
                aria-label="Chiudi"
                title="Chiudi"
              >
                ×
              </button>
            </div>

            <div className="wizard-steps" aria-label="Avanzamento prenotazione">
              <button
                className={bookingFormStep === 1 ? "active" : ""}
                onClick={() => setBookingFormStep(1)}
                type="button"
              >
                <span>1</span>
                Prenotazione
              </button>
              <button
                className={bookingFormStep === 2 ? "active" : ""}
                onClick={() => {
                  if (isBookingDetailsValid) {
                    setBookingFormStep(2);
                    setNotice(null);
                  } else {
                    continueBookingWizard();
                  }
                }}
                type="button"
              >
                <span>2</span>
                Scarico
              </button>
            </div>

            <div className="booking-wizard-body">
              {notice ? (
                <div
                  aria-live={notice.type === "error" ? "assertive" : "polite"}
                  className={`notice ${notice.type}`}
                  role={notice.type === "error" ? "alert" : "status"}
                >
                  {notice.text}
                </div>
              ) : null}

              {bookingFormStep === 1 ? (
                <div className="wizard-section">
                  <label>
                    Nome e cognome
                    <input
                      autoComplete="name"
                      required
                      aria-invalid={showFieldError("organizerName", organizerName.trim().length < 2) || undefined}
                      value={organizerName}
                      onBlur={() => markTouched("organizerName")}
                      onChange={(event) => setOrganizerName(event.target.value)}
                      placeholder="Mario Rossi"
                    />
                  </label>
                  <label>
                    Email
                    <input
                      autoComplete="email"
                      inputMode="email"
                      type="email"
                      required
                      aria-invalid={showFieldError("organizerEmail", !isValidEmail(normalizedOrganizerEmail)) || undefined}
                      value={organizerEmail}
                      onBlur={() => {
                        markTouched("organizerEmail");
                        setOrganizerEmail(normalizedOrganizerEmail);
                      }}
                      onChange={(event) => setOrganizerEmail(event.target.value)}
                      placeholder={`nome@${allowedDomain}`}
                    />
                  </label>
                  {isExternalEmail ? (
                    <div className="notice info">
                      Puoi usare questa email, ma quella aziendale aiuta a riconoscerti meglio.
                    </div>
                  ) : null}
                  <label>
                    Giocatori in campo
                    <select
                      value={playerCount}
                      onBlur={() => markTouched("playerCount")}
                      onChange={(event) => {
                        markTouched("playerCount");
                        setPlayerCount(Number(event.target.value));
                      }}
                    >
                      {[2, 3, 4].map((count) => (
                        <option key={count} value={count}>
                          {count} giocatori
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              ) : (
                <div className="wizard-section">
                  <WaiverFormSection
                    birthDateIsValid={Boolean(birthDateIso)}
                    compact
                    helperText="Modulo e regolamento saranno allegati al PDF firmato."
                    regulationUrl={appPath("/legal/regolamento-padel-topfly-v1.pdf")}
                    templateUrl={appPath("/legal/modulo-responsabilita-padel-template-v1.pdf")}
                    showErrors={bookingSubmitAttempted}
                    signerName={organizerName}
                    touched={touchedFields}
                    value={waiverForm}
                    onChange={setWaiverForm}
                    onTouched={markTouched}
                  />
                </div>
              )}
            </div>

            <div className={`booking-wizard-footer ${bookingFormStep === 2 ? "with-note" : ""}`}>
              {bookingFormStep === 1 ? (
                <>
                  <button className="ghost-button" onClick={closeBookingWizard} type="button">
                    Annulla
                  </button>
                  <button className="primary-button" onClick={continueBookingWizard} type="button">
                    Continua
                  </button>
                </>
              ) : (
                <>
                  <small className={`form-submit-hint ${isBookingFormValid ? "success" : ""}`}>
                    {isBookingFormValid
                      ? "Tutto pronto: puoi firmare e prenotare."
                      : `Completa: ${missingBookingFields.slice(0, 3).join(", ")}${
                          missingBookingFields.length > 3 ? "..." : ""
                        }.`}
                  </small>
                  <div className="wizard-footer-actions">
                    <button className="ghost-button" onClick={() => setBookingFormStep(1)} type="button">
                      Indietro
                    </button>
                    <button className="primary-button" onClick={saveBooking} type="button">
                      <Check size={18} />
                      Firma e conferma
                    </button>
                  </div>
                </>
              )}
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
