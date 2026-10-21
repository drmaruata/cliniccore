import type { Metadata } from "next";

import LoginForm from "./form";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to your ClinicCore account",
};

export default function LoginPage() {
  return <LoginForm />;
}
