import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Better Auth + Prisma on D1",
  description: "Better Auth + Prisma running on Cloudflare D1 via Creek (zero app-code change).",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
