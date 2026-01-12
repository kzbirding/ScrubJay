// apps/scrubjay-discord/src/sheets/sheets.client.ts
import { google, sheets_v4 } from "googleapis";

function mustGetEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function parseServiceAccountJson(raw: string): {
  client_email: string;
  private_key: string;
} {
  // Railway/Windows sometimes ends up with literal "\n" in the private_key
  const json = JSON.parse(raw);
  if (!json.client_email || !json.private_key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON must include client_email and private_key");
  }
  return {
    client_email: String(json.client_email),
    private_key: String(json.private_key).replace(/\\n/g, "\n"),
  };
}

let cachedSheets: sheets_v4.Sheets | null = null;

/**
 * Returns an authenticated Google Sheets client.
 * Requires:
 *  - GOOGLE_SERVICE_ACCOUNT_JSON (full JSON key)
 */
export function getSheetsClient(): sheets_v4.Sheets {
  if (cachedSheets) return cachedSheets;

  const raw = mustGetEnv("GOOGLE_SERVICE_ACCOUNT_JSON");
  const sa = parseServiceAccountJson(raw);

  const auth = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  cachedSheets = google.sheets({ version: "v4", auth });
  return cachedSheets;
}

/**
 * Convenience: returns your Big Day sheet id from env.
 * Requires:
 *  - BIGDAY_SHEET_ID
 */
export function getBigdaySheetId(): string {
  return mustGetEnv("BIGDAY_SHEET_ID");
}
