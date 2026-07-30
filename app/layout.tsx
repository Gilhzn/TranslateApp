import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LingoLoop — AI Localization Agent",
  description:
    "Zero-configuration localization for micro-SaaS and indie games. Upload en.json, get layout-safe, context-aware translations back.",
  applicationName: "LingoLoop",
};

export const viewport: Viewport = {
  themeColor: "#0a0a0c",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
