import type { Metadata } from "next";
import { Geist } from "next/font/google";

import "./globals.css";

/*
 * `--font-sans` is what `@theme inline` in app/globals.css points both
 * `font-sans` and `font-heading` at, so the Geist variable class on <html> is
 * what makes the type utilities resolve.
 */
const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: "ClinicCore",
  description: "Multi-tenant clinic management",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={geist.variable}>
      <body>{children}</body>
    </html>
  );
}
