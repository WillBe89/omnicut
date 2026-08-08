import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, copyFileSync, mkdirSync } from "node:fs";
import { authorize, type OAuth2Client } from "./auth.js";

export const CREDENTIALS_DIR = join(homedir(), ".omnicut", "youtube");
export const CLIENT_SECRET_PATH = join(CREDENTIALS_DIR, "client_secret.json");
export const TOKEN_PATH = join(CREDENTIALS_DIR, "token.json");

export function hasStoredCredentials(): boolean {
  return existsSync(CLIENT_SECRET_PATH);
}

export type ClientSecretValidation =
  | { ok: true; clientId: string }
  | { ok: false; error: string };

/** Sanity-checks a downloaded OAuth client JSON BEFORE attempting to use it —
 *  catches the single most common real-world mistake (picking the "Web
 *  application" client type instead of "Desktop app" in Cloud Console,
 *  which isn't the default selection) with a specific, actionable message
 *  instead of a cryptic OAuth failure several steps later. */
export function validateClientSecretFile(path: string): ClientSecretValidation {
  let raw: { installed?: { client_id?: string }; web?: { client_id?: string } };
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { ok: false, error: "Couldn't read this as a JSON file — make sure you picked the file Google Cloud Console downloaded." };
  }
  if (raw.web && !raw.installed) {
    return { ok: false, error: "This is a \"Web application\" OAuth client — go back to Credentials and create one with type \"Desktop app\" instead." };
  }
  const clientId = raw.installed?.client_id;
  if (!clientId) {
    return { ok: false, error: "This doesn't look like an OAuth client JSON (no 'installed' client_id found)." };
  }
  return { ok: true, clientId };
}

/** Copies a downloaded OAuth client JSON into OmniCut's own stable storage
 *  (`~/.omnicut/youtube/`) so the account keeps working even if the original
 *  download gets moved or deleted later — used the first time OmniCut is
 *  ever connected to YouTube. */
export function installClientSecret(sourcePath: string): void {
  mkdirSync(CREDENTIALS_DIR, { recursive: true });
  copyFileSync(sourcePath, CLIENT_SECRET_PATH);
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
