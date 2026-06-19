import { redirect } from "next/navigation";
import { BookingApp } from "@/components/booking-app";
import { createBookingInitialState } from "@/lib/booking-initial-state";
import { appConfig } from "@/lib/config";
import { requireCurrentUser } from "@/lib/server-auth";

export default async function AdminPage() {
  const user = await requireCurrentUser();

  if (user.role !== "ADMIN") {
    redirect("/signin");
  }

  return (
    <BookingApp
      adminMode
      initialState={createBookingInitialState(new Date(), appConfig.timeZone)}
      initialUser={user}
    />
  );
}
