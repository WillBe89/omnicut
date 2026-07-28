/**
 * OAuth2 for the YouTube Data API v3, using the "installed app" loopback flow:
 * we open the user's own default browser to Google's consent screen and
 * listen on a local ephemeral port for the redirect. The user logs in and
 * consents in their own browser — this code never sees their credentials.
 *
 * Requires a one-time setup in Google Cloud Console (see README): enable the
 * YouTube Data API v3, create an OAuth Client ID of type "Desktop app", and
 * save the downloaded JSON as the `clientSecretPath` passed to `authorize()`.
 */
import { google } from "googleapis";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { exec } from "node:child_process";
import { dirname } from "node:path";

/** Derived directly from googleapis' own OAuth2 constructor to avoid a type
 *  mismatch against the separate google-auth-library copy nested inside
 *  googleapis-common's dependency tree. */
export type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube",
];

interface ClientSecretFile {
  installed?: { client_id: string; client_secret: string };
  web?: { client_id: string; client_secret: string };
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd);
}

/** Load (or create via browser consent) an authorized OAuth2 client. */
export async function authorize(clientSecretPath: string, tokenPath: string): Promise<OAuth2Client> {
  const raw = JSON.parse(readFileSync(clientSecretPath, "utf8")) as ClientSecretFile;
  const creds = raw.installed ?? raw.web;
  if (!creds) throw new Error("Client secret JSON missing 'installed' or 'web' key — did you download the OAuth Desktop app credentials?");

  if (existsSync(tokenPath)) {
    // redirect_uri is unused for token refresh (only needed for the initial
    // code exchange), so it's fine to omit here.
    const oAuth2Client = new google.auth.OAuth2(creds.client_id, creds.client_secret);
    oAuth2Client.setCredentials(JSON.parse(readFileSync(tokenPath, "utf8")));
    return oAuth2Client;
  }
  return runConsentFlow(creds.client_id, creds.client_secret, tokenPath);
}

function runConsentFlow(clientId: string, clientSecret: string, tokenPath: string): Promise<OAuth2Client> {
  return new Promise((resolve, reject) => {
    let oAuth2Client: OAuth2Client;

    const server = createServer(async (req, res) => {
      try {
        if (!req.url) return;
        const url = new URL(req.url, "http://127.0.0.1");
        const code = url.searchParams.get("code");
        const errParam = url.searchParams.get("error");
        if (errParam) {
          res.end(`<html><body>Consent denied (${errParam}). You can close this tab.</body></html>`);
          server.close();
          return reject(new Error(`OAuth consent denied: ${errParam}`));
        }
        if (!code) return;
        res.end("<html><body>Authorized — you can close this tab and return to the terminal.</body></html>");
        server.close();

        const { tokens } = await oAuth2Client.getToken(code);
        oAuth2Client.setCredentials(tokens);
        mkdirSync(dirname(tokenPath), { recursive: true });
        writeFileSync(tokenPath, JSON.stringify(tokens, null, 2), "utf8");
        resolve(oAuth2Client);
      } catch (err) {
        reject(err);
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
      oAuth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
      const authUrl = oAuth2Client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent", // force a refresh_token even on repeat consent
        scope: SCOPES,
      });
      console.error(`\nOpening your browser to authorize this app with YouTube…\nIf it doesn't open, visit:\n${authUrl}\n`);
      openBrowser(authUrl);
    });
  });
}
