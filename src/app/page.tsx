import { BookingApp } from "@/components/booking-app";
import { getAvailability } from "@/lib/booking-service";
import { createBookingInitialState } from "@/lib/booking-initial-state";
import { appConfig } from "@/lib/config";
import { getCurrentUser } from "@/lib/server-auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  const initialState = createBookingInitialState(new Date(), appConfig.timeZone);
  // Un admin che apre il calendario pubblico deve vedere il nome intero come nell'API di refresh:
  // risolviamo il viewer anche qui per non avere un flash di "Nome I." prima del primo fetch.
  const user = await getCurrentUser();
  const initialAvailability = await getAvailability(initialState.date, user);

  return (
    <BookingApp
      initialAvailability={initialAvailability}
      initialState={initialState}
    />
  );
}
