import { createServerClient } from "@/lib/supabase/server";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get("code");

  if (!code) {
    return NextResponse.json(
      { error: "No verification code provided", code: "missing_code" },
      { status: 400 },
    );
  }

  const supabase = await createServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.json(
      { error: "Invalid or expired verification code", code: "invalid_code" },
      { status: 400 },
    );
  }

  return NextResponse.json({ success: true });
}
