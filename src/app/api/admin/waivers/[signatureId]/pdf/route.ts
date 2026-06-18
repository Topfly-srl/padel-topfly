import { noStoreHeaders, routeError } from "@/lib/errors";
import { assertAdmin, requireApiUser } from "@/lib/server-auth";
import { getAdminWaiverPdf } from "@/lib/waiver-service";

type RouteContext = {
  params: Promise<{ signatureId: string }>;
};

function contentDisposition(filename: string) {
  const safeFilename = filename.replace(/["\\\r\n]/g, "");
  return `attachment; filename="${safeFilename}"`;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const user = await requireApiUser();
    assertAdmin(user);
    const { signatureId } = await context.params;
    const pdf = await getAdminWaiverPdf(signatureId);

    return new Response(new Uint8Array(pdf.bytes), {
      headers: {
        ...noStoreHeaders,
        "Content-Type": "application/pdf",
        "Content-Disposition": contentDisposition(pdf.filename),
        "X-Document-Sha256": pdf.sha256,
      },
    });
  } catch (error) {
    return routeError(error);
  }
}
