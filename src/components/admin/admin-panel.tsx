"use client";

import { Shield } from "lucide-react";
import type { Notice } from "@/lib/booking-ui";
import type {
  AdminStats,
  AuditAction,
  AuditItem,
  AvailabilityBlock,
  AvailabilityBooking,
} from "@/lib/types";
import { AdminAuditSection } from "@/components/admin/admin-audit-section";
import { AdminBlocksSection } from "@/components/admin/admin-blocks-section";
import { AdminDayBookingsSection } from "@/components/admin/admin-day-bookings-section";
import { AdminStatsSection } from "@/components/admin/admin-stats-section";
import {
  AdminWaiversSection,
  type AdminWaiverItem,
} from "@/components/admin/admin-waivers-section";

// Contenitore del pannello admin: tiene insieme il titolo di sezione e le
// cinque sotto-sezioni (blocchi, prenotazioni del giorno, scarichi, statistiche,
// storico). Non possiede stato di fetch: il calendario (booking-app) resta il
// proprietario dei dati admin perche' il refresh condiviso e l'aggregazione
// degli avvisi restano un unico flusso. Qui arrivano solo props esplicite.
export function AdminPanel({
  isAdminLoading,
  options,
  selectedDate,
  timeZone,
  dayBlocks,
  onRefresh,
  setNotice,
  dayBookings,
  onEditBooking,
  onCancelBooking,
  adminWaivers,
  adminWaiverStatusFilter,
  onWaiverStatusFilterChange,
  adminWaiverRoleFilter,
  onWaiverRoleFilterChange,
  adminWaiverQuery,
  onWaiverQueryChange,
  isAdminWaiversLoading,
  adminWaiverNextCursor,
  onLoadMoreWaivers,
  onRetryWaiver,
  stats,
  isStatsLoading,
  audit,
  auditActionFilter,
  onAuditActionFilterChange,
  isAuditLoading,
  auditNextCursor,
  onLoadMoreAudit,
}: {
  isAdminLoading: boolean;
  options: string[];
  selectedDate: string;
  // Fuso del campo (da booking-app): tutte le sotto-sezioni formattano orari "di parete".
  timeZone: string;
  dayBlocks: AvailabilityBlock[];
  onRefresh: () => Promise<void>;
  setNotice: (notice: Notice) => void;
  dayBookings: AvailabilityBooking[];
  onEditBooking: (booking: AvailabilityBooking) => void;
  onCancelBooking: (booking: AvailabilityBooking) => void;
  adminWaivers: AdminWaiverItem[];
  adminWaiverStatusFilter: AdminWaiverItem["emailStatus"] | "ALL";
  onWaiverStatusFilterChange: (value: AdminWaiverItem["emailStatus"] | "ALL") => void;
  adminWaiverRoleFilter: AdminWaiverItem["signerRole"] | "ALL";
  onWaiverRoleFilterChange: (value: AdminWaiverItem["signerRole"] | "ALL") => void;
  adminWaiverQuery: string;
  onWaiverQueryChange: (value: string) => void;
  isAdminWaiversLoading: boolean;
  adminWaiverNextCursor: string | null;
  onLoadMoreWaivers: () => void;
  onRetryWaiver: (signatureId: string) => void;
  stats: AdminStats | null;
  isStatsLoading: boolean;
  audit: AuditItem[];
  auditActionFilter: AuditAction | "ALL";
  onAuditActionFilterChange: (value: AuditAction | "ALL") => void;
  isAuditLoading: boolean;
  auditNextCursor: string | null;
  onLoadMoreAudit: () => void;
}) {
  return (
    <section className="panel admin-panel">
      <div className="section-title">
        <Shield size={18} />
        <span>Admin</span>
        {isAdminLoading ? <span className="loading-pill">Aggiorno</span> : null}
      </div>

      <AdminBlocksSection
        options={options}
        selectedDate={selectedDate}
        timeZone={timeZone}
        dayBlocks={dayBlocks}
        onRefresh={onRefresh}
        setNotice={setNotice}
      />

      <AdminDayBookingsSection
        dayBookings={dayBookings}
        timeZone={timeZone}
        onEditBooking={onEditBooking}
        onCancelBooking={onCancelBooking}
      />

      <AdminWaiversSection
        adminWaivers={adminWaivers}
        timeZone={timeZone}
        adminWaiverStatusFilter={adminWaiverStatusFilter}
        onStatusFilterChange={onWaiverStatusFilterChange}
        adminWaiverRoleFilter={adminWaiverRoleFilter}
        onRoleFilterChange={onWaiverRoleFilterChange}
        adminWaiverQuery={adminWaiverQuery}
        onQueryChange={onWaiverQueryChange}
        isAdminWaiversLoading={isAdminWaiversLoading}
        adminWaiverNextCursor={adminWaiverNextCursor}
        onLoadMore={onLoadMoreWaivers}
        onRetry={onRetryWaiver}
      />

      <AdminStatsSection stats={stats} isStatsLoading={isStatsLoading} timeZone={timeZone} />

      <AdminAuditSection
        audit={audit}
        timeZone={timeZone}
        auditActionFilter={auditActionFilter}
        onAuditActionFilterChange={onAuditActionFilterChange}
        isAuditLoading={isAuditLoading}
        auditNextCursor={auditNextCursor}
        onLoadMore={onLoadMoreAudit}
      />
    </section>
  );
}
