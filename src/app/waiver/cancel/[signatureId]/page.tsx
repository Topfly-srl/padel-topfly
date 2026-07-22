import type { Metadata } from "next";
import { WaiverCancel } from "@/components/waiver-cancel";
import { appConfig } from "@/lib/config";

export const metadata: Metadata = {
  referrer: "no-referrer",
};

type PageProps = {
  params: Promise<{ signatureId: string }>;
  searchParams: Promise<{ token?: string }>;
};

export default async function WaiverCancelPage({ params, searchParams }: PageProps) {
  const [{ signatureId }, query] = await Promise.all([params, searchParams]);

  return <WaiverCancel signatureId={signatureId} token={query.token ?? ""} timeZone={appConfig.timeZone} />;
}
