export function appPath(path: string) {
  if (/^https?:\/\//i.test(path)) return path;

  return path.startsWith("/") ? path : `/${path}`;
}
