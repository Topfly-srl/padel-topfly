import { redirect } from "next/navigation";
import { BookingApp } from "@/components/booking-app";
import { requireCurrentUser } from "@/lib/server-auth";

export default async function AdminPage() {
  const user = await requireCurrentUser();

  if (user.role !== "ADMIN") {
    redirect("/signin");
  }

  return <BookingApp adminMode initialUser={user} />;
}
