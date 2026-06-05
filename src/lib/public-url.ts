import type { NextRequest } from "next/server";
import { appConfig } from "@/lib/config";

export function getPublicBaseUrl(request: NextRequest) {
  return appConfig.publicOrigin ?? request.nextUrl.origin;
}
