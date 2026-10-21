import type { Metadata } from "next";
import Link from "next/link";
import { Geist } from "next/font/google";

import "../globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });

export const metadata: Metadata = {
  title: "Sign in | ClinicCore",
  description: "Sign in to your ClinicCore account",
};

export default function AuthLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={geist.variable}>
      <body className="min-h-svh flex items-center justify-center bg-muted/30 px-4">
        <main className="w-full max-w-md">
          <header className="mb-8 flex justify-between items-center">
            <Link href="/" className="text-xl font-semibold text-foreground">
              ClinicCore
            </Link>
          </header>
          {children}
          <footer className="mt-8 text-center text-sm text-muted-foreground">
            <p>&copy; {new Date().getFullYear()} ClinicCore. All rights reserved.</p>
          </footer>
        </main>
      </body>
    </html>
  );
}
