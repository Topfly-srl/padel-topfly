export function normalizeGuestWaiverLink(link: string, origin: string) {
  if (!origin) return link;

  try {
    const url = new URL(link, origin);
    if (url.pathname.startsWith("/waiver/")) {
      return `${origin}${url.pathname}${url.search}${url.hash}`;
    }
    return url.toString();
  } catch {
    return link;
  }
}

export function buildShortGuestWaiverLink(link: string, origin: string) {
  if (!origin) return link;

  try {
    const url = new URL(link, origin);
    const bookingId = url.pathname.startsWith("/waiver/")
      ? url.pathname.replace(/^\/waiver\//, "").split("/")[0]
      : "";
    const token = url.searchParams.get("token");

    if (bookingId && token) {
      return `${origin}/w/${encodeURIComponent(bookingId)}/${encodeURIComponent(token)}`;
    }

    return normalizeGuestWaiverLink(link, origin);
  } catch {
    return link;
  }
}
