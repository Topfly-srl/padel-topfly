import { redirect } from "next/navigation";
import { BookingApp } from "@/components/booking-app";
import { getAvailability } from "@/lib/booking-service";
import { createBookingInitialState } from "@/lib/booking-initial-state";
import { appConfig } from "@/lib/config";
import { requireCurrentUser } from "@/lib/server-auth";

export default async function AdminPage() {
  const user = await requireCurrentUser();

  if (user.role !== "ADMIN") {
    redirect("/signin");
  }

  const initialState = createBookingInitialState(new Date(), appConfig.timeZone);
  const initialAvailability = await getAvailability(initialState.date);

  return (
    <BookingApp
      adminMode
      initialAvailability={initialAvailability}
      initialState={initialState}
      initialUser={user}
    />
  );
}
