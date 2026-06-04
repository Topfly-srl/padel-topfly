import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-app",
});

export const metadata: Metadata = {
  title: "Padel TOPFLY",
  description: "Prenotazione interna del campo da padel aziendale.",
  icons: {
    icon: "/topfly-favicon.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f31317",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="it">
      <body className={inter.variable}>{children}</body>
    </html>
  );
}
