/**
 * /api/auth/[...all] — better-auth handler (sign-up, sign-in, sign-out,
 * session). All auth traffic goes through here; the client in
 * src/lib/auth-client.ts calls these endpoints.
 */

import { NextResponse } from "next/server";
import { auth, requireAuthEnv } from "@/lib/auth";

async function handle(req: Request): Promise<Response> {
  try {
    requireAuthEnv();
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
  return auth.handler(req);
}

export async function GET(req: Request): Promise<Response> {
  return handle(req);
}

export async function POST(req: Request): Promise<Response> {
  return handle(req);
}
