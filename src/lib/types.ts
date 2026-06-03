import type { BookingStatus, OutlookSyncStatus, UserRole } from "@prisma/client";

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
};

export type AuditItem = {
  id: string;
  actorEmail: string;
  action: string;
  entityType: string;
  entityId: string | null;
  createdAt: string;
};
