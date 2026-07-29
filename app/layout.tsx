import type { Metadata, Viewport } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "FlexiDim",
  description: "Control a JC Lighting FlexiDim Scene Controller from a browser.",
  applicationName: "FlexiDim",
  appleWebApp: { capable: true, title: "FlexiDim", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // The controls are already large; letting the page zoom mostly means
  // accidental pinch-zoom while dragging a brightness slider.
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#12151c" },
    { media: "(prefers-color-scheme: light)", color: "#f4f5f7" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
