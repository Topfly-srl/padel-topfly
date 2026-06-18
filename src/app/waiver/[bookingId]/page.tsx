import { WaiverSigning } from "@/components/waiver-signing";
import { appConfig } from "@/lib/config";

type PageProps = {
  params: Promise<{ bookingId: string }>;
  searchParams: Promise<{ token?: string }>;
};

export default async function WaiverPage({ params, searchParams }: PageProps) {
  const [{ bookingId }, query] = await Promise.all([params, searchParams]);

  return (
    <WaiverSigning
      bookingId={bookingId}
      environmentLabel={appConfig.publicEnvironmentLabel}
      token={query.token ?? ""}
    />
  );
}
