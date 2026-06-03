import { BookingApp } from "@/components/booking-app";
import { requireCurrentUser } from "@/lib/server-auth";

export default async function Home() {
  const user = await requireCurrentUser();

  return <BookingApp initialUser={user} />;
}
