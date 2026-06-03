import { ManageBooking } from "@/components/manage-booking";

type ManagePageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ token?: string }>;
};

export default async function ManagePage({ params, searchParams }: ManagePageProps) {
  const [{ id }, { token }] = await Promise.all([params, searchParams]);

  return <ManageBooking bookingId={id} manageToken={token ?? ""} />;
}
