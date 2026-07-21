import type { BookingStatus, OutlookSyncStatus, UserRole, WaiverEmailStatus } from "@/generated/prisma/client";

export type CurrentUser = {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
};

export type AvailabilityBooking = {
  id: string;
  start: string;
  end: string;
  status: BookingStatus;
  organizerName: string;
  outlookSyncStatus: OutlookSyncStatus;
  playerCount: number;
  waiverSignedCount: number;
  waiverEmailStatus: WaiverEmailStatus | null;
  signatureDeadlineAt: string | null;
  signatureConfirmedAt: string | null;
  autoCanceledAt: string | null;
};

export type AvailabilityBlock = {
  id: string;
  start: string;
  end: string;
  reason: string;
};

export type MyBooking = AvailabilityBooking & {
  createdAt: string;
  updatedAt: string;
  manageToken?: string;
  manageUrl?: string;
  guestWaiverToken?: string;
  guestWaiverUrl?: string;
  cancelReason: string | null;
};

export type AuditItem = {
  id: string;
  actorEmail: string;
  action: string;
  entityType: string;
  entityId: string | null;
  createdAt: string;
  // Causale dell'annullamento, presente solo sulle righe di cancellazione che ne portano una.
  cancelReason: string | null;
};

// Pagina di registro audit: pattern cursore identico all'archivio firme (items + nextCursor).
export type AuditPage = {
  items: AuditItem[];
  nextCursor: string | null;
};

// Elenco delle action piu' comuni per il filtro del registro admin. La select le mostra tutte,
// il "Tutte" resta il default. Lista condivisa cosi' UI e validazione route non divergono.
export const auditActions = [
  "BOOKING_CREATED",
  "WAIVER_SIGNED",
  "BOOKING_SIGNATURES_COMPLETED",
  "BOOKING_SIGNATURES_INCOMPLETE",
  "BOOKING_CANCELED",
  "BOOKING_AUTO_CANCELED_SIGNATURES",
  "BOOKING_STATUS_CHANGED",
  "BOOKING_UPDATED",
  "WAIVER_SIGNATURE_CANCELED",
  "WAIVER_EMAIL_RETRIED",
  "ADMIN_BLOCK_CREATED",
  "ADMIN_BLOCK_DELETED",
] as const;

export type AuditAction = (typeof auditActions)[number];

// Statistiche admin: solo numeri aggregati, nessun nome. Ogni blocco e' una lista pronta da
// mostrare come tabella sobria, senza librerie grafiche. La demo twin ricostruisce la stessa forma
// sui dati in memoria, cosi' i test coprono l'aggregazione senza database.
export type AdminStats = {
  totalBookings: number;
  // Prenotazioni per settimana di inizio, ultime 8 (dalla piu' vecchia alla piu' recente).
  perWeek: Array<{ weekStart: string; count: number }>;
  // Distribuzione per fascia oraria di inizio (ora locale del fuso), solo le ore con prenotazioni.
  perStartHour: Array<{ hour: number; count: number }>;
  // Conteggio per stato corrente.
  byStatus: Array<{ status: BookingStatus; count: number }>;
  cancellations: {
    total: number;
    // Auto-annullate per firme mancanti: portano autoCanceledAt valorizzato.
    auto: number;
    // Annullate a mano: il resto delle CANCELED.
    manual: number;
    autoPercent: number;
    manualPercent: number;
    // Breakdown delle causali presenti sulle annullate a mano (motivo -> conteggio).
    reasons: Array<{ reason: string; count: number }>;
    // Annullate a mano senza causale indicata.
    manualWithoutReason: number;
  };
};
