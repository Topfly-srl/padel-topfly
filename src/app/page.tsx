import { BookingApp } from "@/components/booking-app";
import { createBookingInitialState } from "@/lib/booking-initial-state";
import { appConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export default async function Home() {
  return (
    <BookingApp
      environmentLabel={appConfig.publicEnvironmentLabel}
      initialState={createBookingInitialState(new Date(), appConfig.timeZone)}
    />
  );
}
