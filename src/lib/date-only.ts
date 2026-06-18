import { z } from "zod";

const isoDateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDateOnly(value: string) {
  if (!isoDateOnlyPattern.test(value)) return false;

  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function isoDateOnlyToDate(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

export const isoDateOnlySchema = z
  .string()
  .refine(isIsoDateOnly, "Inserisci una data valida nel formato yyyy-mm-dd.")
  .transform(isoDateOnlyToDate);
