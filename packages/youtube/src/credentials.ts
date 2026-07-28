import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { authorize, type OAuth2Client } from "./auth.js";

export const CREDENTIALS_DIR = join(homedir(), ".omnicut", "youtube");
export const CLIENT_SECRET_PATH = join(CREDENTIALS_DIR, "client_secret.json");
export const TOKEN_PATH = join(CREDENTIALS_DIR, "token.json");

export function hasStoredCredentials(): boolean {
  return existsSync(CLIENT_SECRET_PATH);
}

export function hasStoredToken(): boolean {
  return existsSync(TOKEN_PATH);
}

/** Authorize using the standard app-wide credential location (shared by the
 *  CLI and the desktop app, so either surface can complete `init` and both
 *  immediately see the result). */
export async function authorizeStored(): Promise<OAuth2Client> {
  if (!hasStoredCredentials()) {
    throw new Error(
      "No YouTube credentials found. Run the one-time setup (Google Cloud OAuth client) first.",
    );
  }
  return authorize(CLIENT_SECRET_PATH, TOKEN_PATH);
}
