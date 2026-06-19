import { redirect } from "next/navigation";
import { appPath } from "@/lib/app-path";

type ShortWaiverPageProps = {
  params: Promise<{
    bookingId: string;
    token: string;
  }>;
};

export default async function ShortWaiverPage({ params }: ShortWaiverPageProps) {
  const { bookingId, token } = await params;

  redirect(appPath(`/waiver/${encodeURIComponent(bookingId)}?token=${encodeURIComponent(token)}`));
}
