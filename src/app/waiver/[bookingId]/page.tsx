import type { Metadata } from "next";
import { WaiverSigning } from "@/components/waiver-signing";
import { appConfig } from "@/lib/config";

export const metadata: Metadata = {
  referrer: "no-referrer",
};

type PageProps = {
  params: Promise<{ bookingId: string }>;
  searchParams: Promise<{ token?: string }>;
};

export default async function WaiverPage({ params, searchParams }: PageProps) {
  const [{ bookingId }, query] = await Promise.all([params, searchParams]);

  return <WaiverSigning bookingId={bookingId} token={query.token ?? ""} timeZone={appConfig.timeZone} />;
}
