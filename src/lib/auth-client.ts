/**
 * auth-client.ts — better-auth client (browser session hooks).
 *
 * Import from client components only. Session state drives the header
 * (Sign in vs History/Sign out) and gates history saving/loading.
 */

"use client";

import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();

export const { useSession, signIn, signUp, signOut } = authClient;
