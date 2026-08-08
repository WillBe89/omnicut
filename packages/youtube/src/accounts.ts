/**
 * Multi-account support: one OAuth "app" (client_secret.json) can authorize
 * many different Google accounts/channels — each gets its own token, not its
 * own app. So an "account" here is really just a named token + (usually
 * shared) client secret, letting you keep a primary channel and any number of
 * other channels (e.g. a separate project or brand) side by side and pick
 * which one a given folder uses.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, unlinkSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import {
  CREDENTIALS_DIR, CLIENT_SECRET_PATH as DEFAULT_CLIENT_SECRET_PATH, TOKEN_PATH as DEFAULT_TOKEN_PATH,
  hasStoredCredentials, installClientSecret,
} from "./credentials.js";
import { authorize, type OAuth2Client } from "./auth.js";

const ACCOUNTS_DIR = join(CREDENTIALS_DIR, "accounts");
const ACCOUNTS_REGISTRY = join(CREDENTIALS_DIR, "accounts.json");
export const DEFAULT_ACCOUNT_ID = "default";

export interface Account {
  id: string;
  label: string;
  channelTitle?: string;
  tokenPath: string;
  /** Usually the same OAuth app/client for every account — override only if a
   *  channel needs its own Google Cloud project. */
  clientSecretPath: string;
}

function loadRegistry(): Account[] {
  if (!existsSync(ACCOUNTS_REGISTRY)) {
    // Migrate silently: the pre-multi-account setup already has a working
    // client_secret.json/token.json at the top level — treat it as "default"
    // without moving anything or forcing re-consent.
    if (existsSync(DEFAULT_TOKEN_PATH)) {
      const bootstrap: Account[] = [{
        id: DEFAULT_ACCOUNT_ID, label: "Default", tokenPath: DEFAULT_TOKEN_PATH, clientSecretPath: DEFAULT_CLIENT_SECRET_PATH,
      }];
      saveRegistry(bootstrap);
      return bootstrap;
    }
    return [];
  }
  try {
    return JSON.parse(readFileSync(ACCOUNTS_REGISTRY, "utf8")) as Account[];
  } catch {
    return [];
  }
}

function saveRegistry(accounts: Account[]): void {
  mkdirSync(CREDENTIALS_DIR, { recursive: true });
  writeFileSync(ACCOUNTS_REGISTRY, JSON.stringify(accounts, null, 2), "utf8");
}

export function listAccounts(): Account[] {
  return loadRegistry();
}

export function getAccount(id: string): Account | undefined {
  return loadRegistry().find((a) => a.id === id);
}

/** Register a new account slot (not yet authorized — call authorizeAccount to
 *  complete the browser consent and get a real token). */
export function addAccount(id: string, label: string, clientSecretPath?: string): Account {
  const accounts = loadRegistry();
  if (accounts.some((a) => a.id === id)) throw new Error(`Account "${id}" already exists.`);
  mkdirSync(join(ACCOUNTS_DIR, id), { recursive: true });
  const account: Account = {
    id,
    label,
    tokenPath: join(ACCOUNTS_DIR, id, "token.json"),
    clientSecretPath: clientSecretPath ?? DEFAULT_CLIENT_SECRET_PATH,
  };
  accounts.push(account);
  saveRegistry(accounts);
  return account;
}

export function removeAccount(id: string): void {
  if (id === DEFAULT_ACCOUNT_ID) throw new Error("Can't remove the default account.");
  saveRegistry(loadRegistry().filter((a) => a.id !== id));
}

function updateAccount(id: string, patch: Partial<Account>): void {
  const accounts = loadRegistry();
  const account = accounts.find((a) => a.id === id);
  if (account) {
    Object.assign(account, patch);
    saveRegistry(accounts);
  }
}

// ── Real queueing, not fail-fast locking ──────────────────────────────────
//
// Two layers, so uploads across DIFFERENT accounts run fully concurrently
// while operations on the SAME account always wait their turn instead of
// erroring out:
//  1. An in-process promise chain per account — handles concurrent calls
//     within one process (e.g. the GUI's "run everything" firing off every
//     folder's upload at once via Promise.all).
//  2. A waiting file lock (poll + backoff, not fail-fast) — handles the
//     cross-process case (a scheduled Task Scheduler run overlapping with a
//     manual click in the GUI), so the second caller waits rather than dying.

const STALE_LOCK_MS = 10 * 60 * 1000; // a lock this old is almost certainly a crashed process
const LOCK_WAIT_TIMEOUT_MS = 5 * 60 * 1000; // give up only if truly stuck
const LOCK_POLL_MS = 300;

const inProcessChains = new Map<string, Promise<unknown>>();

/** Queue `fn` behind any other in-process call for the same account — never
 *  rejects the chain itself, so one failure doesn't jam up later callers. */
function withInProcessQueue<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  const prior = inProcessChains.get(accountId) ?? Promise.resolve();
  const result = prior.then(fn, fn);
  inProcessChains.set(accountId, result.catch(() => {}));
  return result;
}

async function acquireFileLock(accountId: string): Promise<() => void> {
  const lockPath = join(ACCOUNTS_DIR, accountId, ".lock");
  mkdirSync(join(ACCOUNTS_DIR, accountId), { recursive: true });
  const start = Date.now();
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx"); // exclusive create — fails if it already exists
      closeSync(fd);
      return () => { try { unlinkSync(lockPath); } catch { /* already gone */ } };
    } catch {
      const age = existsSync(lockPath) ? Date.now() - statSync(lockPath).mtimeMs : Infinity;
      if (age > STALE_LOCK_MS) {
        try { unlinkSync(lockPath); } catch { /* another waiter already cleared it */ }
        continue; // retry the create now that the stale lock is gone
      }
      if (Date.now() - start > LOCK_WAIT_TIMEOUT_MS) {
        throw new Error(`Account "${accountId}" has been busy for over 5 minutes — something may be stuck.`);
      }
      await new Promise((r) => setTimeout(r, LOCK_POLL_MS)); // wait, then retry — this is the "queue"
    }
  }
}

/** Authorize (or reuse the stored token for) a named account, holding a lock
 *  for the duration of the caller's operation so nothing else touches this
 *  account's token file at the same time. */
export async function withAccountAuth<T>(accountId: string, fn: (auth: OAuth2Client) => Promise<T>): Promise<T> {
  return withInProcessQueue(accountId, async () => {
    const account = getAccount(accountId);
    if (!account) throw new Error(`Unknown account "${accountId}". Add it first.`);
    const release = await acquireFileLock(accountId);
    try {
      const auth = await authorize(account.clientSecretPath, account.tokenPath);
      return await fn(auth);
    } finally {
      release();
    }
  });
}

/** Run the consent flow for an account and record its channel name once done. */
export async function completeAccountAuth(accountId: string): Promise<string> {
  return withAccountAuth(accountId, async (auth) => {
    const { google } = await import("googleapis");
    const youtube = google.youtube({ version: "v3", auth });
    const res = await youtube.channels.list({ part: ["snippet"], mine: true });
    const channelTitle = res.data.items?.[0]?.snippet?.title ?? "(unknown channel)";
    updateAccount(accountId, { channelTitle });
    return channelTitle;
  });
}

/** Full first-time setup: install the just-downloaded OAuth client JSON into
 *  OmniCut's own stable storage (so it survives the original download being
 *  moved/deleted), register the first account, and run its consent flow —
 *  everything the guided setup wizard's last step needs in one call. Only
 *  for when NO credentials exist yet; for an additional account on an
 *  already-set-up install, use addAccount()+completeAccountAuth() directly
 *  (no file needed, they share the existing OAuth client). */
export async function setupFirstAccount(id: string, label: string, clientSecretSourcePath: string): Promise<string> {
  if (hasStoredCredentials()) {
    throw new Error("Credentials already exist — use \"Add account\" instead of guided setup.");
  }
  installClientSecret(clientSecretSourcePath);
  addAccount(id, label);
  return completeAccountAuth(id);
}

/** Force a fresh consent screen for an account whose stored token predates a
 *  scope that got added later (e.g. Analytics) — `authorize()` otherwise just
 *  reuses whatever's on disk and never notices new scopes are needed. Deletes
 *  the existing token first so the browser flow actually runs again. */
export async function reauthorizeAccount(accountId: string): Promise<string> {
  const account = getAccount(accountId);
  if (!account) throw new Error(`Unknown account "${accountId}". Add it first.`);
  return withInProcessQueue(accountId, async () => {
    const release = await acquireFileLock(accountId);
    try {
      if (existsSync(account.tokenPath)) unlinkSync(account.tokenPath);
      const auth = await authorize(account.clientSecretPath, account.tokenPath);
      const { google } = await import("googleapis");
      const youtube = google.youtube({ version: "v3", auth });
      const res = await youtube.channels.list({ part: ["snippet"], mine: true });
      const channelTitle = res.data.items?.[0]?.snippet?.title ?? "(unknown channel)";
      updateAccount(accountId, { channelTitle });
      return channelTitle;
    } finally {
      release();
    }
  });
}
