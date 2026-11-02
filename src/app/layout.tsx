import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster as SonnerToaster } from "sonner";
import { APP } from "@/config/app";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// PR-26 (production-readiness audit) — metadataBase pins the canonical origin
// for metadata URLs (icons, OG images) so crawlers resolve them absolutely.
// Falls back to a placeholder when APP_URL/NEXTAUTH_URL are unset (sandbox).
function resolveMetadataBase(): URL {
  const raw = process.env.APP_URL || process.env.NEXTAUTH_URL;
  try {
    if (raw) return new URL(raw);
  } catch {
    // fall through to the placeholder
  }
  return new URL("http://localhost:3000");
}

export const metadata: Metadata = {
  metadataBase: resolveMetadataBase(),
  title: `${APP.name} — ${APP.tagline}`,
  description: "Plan sprints, track tasks, schedule events, and visualize team performance — all in one calm, focused workspace.",
  keywords: [APP.name, "project management", "kanban", "team", "analytics"],
  icons: {
    icon: "/logo.svg",
  },
};

// PR-26 — explicit viewport export with the app's theme colour (previously the
// Next default viewport applied; PWA/OS chrome now picks up the brand colour).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f5f0" },
    { media: "(prefers-color-scheme: dark)", color: "#1a1d1a" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning data-accent="forest">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <SonnerToaster
          position="bottom-right"
          toastOptions={{
            style: {
              background: "var(--card)",
              border: "1px solid var(--border)",
              color: "var(--foreground)",
            },
          }}
        />
      </body>
    </html>
  );
}
