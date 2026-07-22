import type { Metadata } from "next";
import { ManageBooking } from "@/components/manage-booking";
import { appConfig } from "@/lib/config";

export const metadata: Metadata = {
  referrer: "no-referrer",
};

type ManagePageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ token?: string }>;
};

export default async function ManagePage({ params, searchParams }: ManagePageProps) {
  const [{ id }, { token }] = await Promise.all([params, searchParams]);

  // Il fuso configurato arriva dal server come nelle pagine waiver: per le prenotazioni non
  // attive l'availability (che pure lo porta) non viene mai richiesta, e il fallback statico
  // potrebbe divergere da APP_TIME_ZONE.
  return <ManageBooking bookingId={id} manageToken={token ?? ""} timeZone={appConfig.timeZone} />;
}
