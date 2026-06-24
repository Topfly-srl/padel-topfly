import { BookingApp } from "@/components/booking-app";
import { getAvailability } from "@/lib/booking-service";
import { createBookingInitialState } from "@/lib/booking-initial-state";
import { appConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export default async function Home() {
  const initialState = createBookingInitialState(new Date(), appConfig.timeZone);
  const initialAvailability = await getAvailability(initialState.date);

  return (
    <BookingApp
      initialAvailability={initialAvailability}
      initialState={initialState}
    />
  );
}
