import type { Prisma } from "@prisma/client";

// Campi che non devono mai finire nel registro audit: hash di token gestione/rinuncia con le loro
// scadenze, piu' i dettagli tecnici Outlook. La blacklist vive qui, condivisa da booking-service e
// signature-workflow, cosi' il cron e l'ultima firma non riscrivono in chiaro cio' che la regola
// doveva nascondere.
const hiddenAuditFields = new Set([
  "manageTokenHash",
  "manageTokenExpiresAt",
  "guestWaiverTokenHash",
  "guestWaiverTokenExpiresAt",
  "outlookEventId",
  "outlookSyncError",
]);

export function sanitizeAuditValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeAuditValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !hiddenAuditFields.has(key))
        .map(([key, nestedValue]) => [key, sanitizeAuditValue(nestedValue)]),
    );
  }

  return value;
}

export function auditJson(value: unknown) {
  const serializableValue = JSON.parse(JSON.stringify(value));
  return sanitizeAuditValue(serializableValue) as Prisma.InputJsonValue;
}
