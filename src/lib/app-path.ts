const rawBasePath = process.env.NEXT_PUBLIC_APP_BASE_PATH?.trim() ?? "";

export const appBasePath =
  rawBasePath && rawBasePath !== "/"
    ? `/${rawBasePath.replace(/^\/+/, "").replace(/\/+$/, "")}`
    : "";

export function appPath(path: string) {
  if (/^https?:\/\//i.test(path)) return path;

  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `${appBasePath}${cleanPath}`;
}
