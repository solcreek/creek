import type { Metadata } from "next";
import { Geist, JetBrains_Mono } from "next/font/google";
import { RootProvider } from "fumadocs-ui/provider/next";
import "./globals.css";
import { cn } from "@/lib/utils";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://creek.dev"),
  title: "Creek — Deploy to the edge",
  description:
    "Open-source edge deployment platform. Ship full-stack apps to the edge in seconds.",
  // Default openGraph / twitter metadata for every page that doesn't
  // override it in its own generateMetadata(). The image resolves to
  // the generic Creek brand card rendered by the og-api worker at
  // og.creek.dev. Per-page metadata (e.g. /deploy/[...slug]) still
  // fully replaces these when present.
  openGraph: {
    type: "website",
    siteName: "Creek",
    url: "https://creek.dev",
    images: [
      {
        url: "https://og.creek.dev/brand",
        width: 1200,
        height: 630,
        alt: "Creek — Ship full-stack apps.",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    site: "@useCreek",
    images: ["https://og.creek.dev/brand"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={cn("h-full antialiased dark", geist.variable, jetbrainsMono.variable)} suppressHydrationWarning>
      <body className="min-h-full flex flex-col">
        <RootProvider
          theme={{
            defaultTheme: "dark",
            enableSystem: false,
          }}
        >
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
