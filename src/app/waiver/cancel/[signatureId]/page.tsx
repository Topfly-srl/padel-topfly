import { WaiverCancel } from "@/components/waiver-cancel";
import { appConfig } from "@/lib/config";

type PageProps = {
  params: Promise<{ signatureId: string }>;
  searchParams: Promise<{ token?: string }>;
};

export default async function WaiverCancelPage({ params, searchParams }: PageProps) {
  const [{ signatureId }, query] = await Promise.all([params, searchParams]);

  return (
    <WaiverCancel
      environmentLabel={appConfig.publicEnvironmentLabel}
      signatureId={signatureId}
      token={query.token ?? ""}
    />
  );
}
