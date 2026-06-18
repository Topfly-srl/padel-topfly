import type { NextConfig } from "next";
import { networkInterfaces } from "node:os";

function localDevOrigins() {
  const origins = new Set<string>();

  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        origins.add(address.address);
      }
    }
  }

  for (const origin of process.env.NEXT_ALLOWED_DEV_ORIGINS?.split(",") ?? []) {
    const value = origin.trim();
    if (value) {
      origins.add(value);
    }
  }

  return Array.from(origins);
}

const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value:
      "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; upgrade-insecure-requests",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "X-Frame-Options",
    value: "DENY",
  },
];

function shouldApplySecurityHeaders() {
  return process.env.VERCEL_ENV === "production" || process.env.APP_ENV === "production";
}

function normalizedBasePath() {
  const rawBasePath = process.env.APP_BASE_PATH?.trim() || process.env.NEXT_PUBLIC_APP_BASE_PATH?.trim();
  if (!rawBasePath || rawBasePath === "/") return undefined;
  return `/${rawBasePath.replace(/^\/+/, "").replace(/\/+$/, "")}`;
}

const nextConfig: NextConfig = {
  allowedDevOrigins: localDevOrigins(),
  basePath: normalizedBasePath(),
  poweredByHeader: false,
  async headers() {
    if (!shouldApplySecurityHeaders()) {
      return [];
    }

    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
