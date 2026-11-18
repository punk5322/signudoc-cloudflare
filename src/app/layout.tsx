import type { Metadata } from "next";
import "allo-font";

import { TooltipProvider } from "@/components/ui/tooltip";
import { NEUTRAL_PRODUCT_NAME } from "@/lib/branding";

import "./globals.css";

export const metadata: Metadata = {
  title: NEUTRAL_PRODUCT_NAME,
  description:
    "Free e-signature software for small businesses. Upload, send, sign — no enterprise circus required.",
  icons: {
    icon: "/icon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
