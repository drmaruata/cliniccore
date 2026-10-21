import type { Metadata } from "next";

import SignupForm from "./form";

export const metadata: Metadata = {
  title: "Create your account | ClinicCore",
  description: "Create a ClinicCore account for your clinic",
};

export default function SignupPage() {
  return <SignupForm />;
}
