import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

// ── Viewport ──────────────────────────────────────────────────────────────────
// viewport-fit=cover exposes env(safe-area-inset-*) to CSS / JS.
// We lock user-scalable to prevent accidental pinch-zoom during a hand.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#060b15",
}

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// ── Metadata ──────────────────────────────────────────────────────────────────
// apple-icon.tsx and icon.tsx (in this same directory) are auto-picked up by
// Next.js and generate the <link rel="apple-touch-icon"> and <link rel="icon">
// tags automatically — no need to repeat them here.
export const metadata: Metadata = {
  title: "Poker",
  description: "Private Texas Hold'em",
  // Link the manifest so browsers show the "Add to Home Screen" prompt
  manifest: "/manifest.webmanifest",
  // iOS PWA: hide Safari chrome when launched from Home Screen
  appleWebApp: {
    capable: true,
    // black-translucent: status bar overlays the app (requires safe-area padding)
    statusBarStyle: "black-translucent",
    title: "Poker",
  },
  // Prevent iOS from auto-linking phone numbers etc.
  formatDetection: {
    telephone: false,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
