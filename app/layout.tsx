import type { Metadata } from "next";
import { Geist } from "next/font/google";

import "./globals.css";

/*
 * `--font-geist-sans` is the name next/font emits. Tailwind's theme points
 * `--font-sans` and `--font-heading` at it (see app/globals.css), so the two
 * halves must agree on the name; naming it `--font-sans` here instead would
 * make the theme reference itself, which resolves to nothing at computed-value
 * time and silently drops every heading to the system font.
 */
const geist = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });

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
