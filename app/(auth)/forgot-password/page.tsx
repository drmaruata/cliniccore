import type { Metadata } from "next";

import ForgotPasswordForm from "./form";

export const metadata: Metadata = {
  title: "Reset your password | ClinicCore",
  description: "Request a password reset link",
};

export default function ForgotPasswordPage() {
  return <ForgotPasswordForm />;
}
