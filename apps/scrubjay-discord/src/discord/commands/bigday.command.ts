import { Injectable } from "@nestjs/common";
import {
  Context,
  Options,
  SlashCommand,
  type SlashCommandContext,
  StringOption,
  Subcommand,
} from "necord";

import { getBigdaySheetId, getSheetsClient } from "@/sheets/sheets.client";

/**
 * REQUIRED Railway env vars:
 *  - MOD_ID (role id allowed to run mod-only commands)
 *  - BIGDAY_SHEET_ID
 *  - GOOGLE_SERVICE_ACCOUNT_JSON
 *  - EBIRD_API_TOKEN (or EBIRD_API_KEY)  (for /bigday submit)
 */

function nowIso() {
  return new Date().toISOString();
}

function mustGetEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function getEbirdToken(): string {
  return process.env.EBIRD_TOKEN ?? process.env.EBIRD_TOKEN ?? "";
}

function hasRole(member: any, roleId: string): boolean {
  // discord.js GuildMember => member.roles.cache.has(...)
  if (member?.roles?.cache?.has) return Boolean(member.roles.cache.has(roleId));

  // APIInteractionGuildMember => member.roles is string[]
  if (Array.isArray(member?.roles)) return member.roles.includes(roleId);

  return false;
}

function assertMod(interaction: any): string | null {
  const roleId = process.env.MOD_ID;
  if (!roleId) return "❌ Server is missing MOD_ID env var.";
  if (!hasRole(interaction.member, roleId)) return "❌ You do not have permission to do that.";
  return null;
}

function extractChecklistSubId(input: string): string | null {
  // Most common: https://ebird.org/checklist/S123456789
  // Also sometimes: .../checklist/S123... or shared URLs; we just find the S######### token.
  const m = input.match(/\bS\d{6,}\b/i);
  return m ? m[0].toUpperCase() : null;
}

function parseNumberLoose(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function sheetGet(range: string) {
  const sheets = getSheetsClient();
  const spreadsheetId = getBigdaySheetId();
  return sheets.spreadsheets.values.get({ spreadsheetId, range });
}

async function sheetUpdate(range: string, values: any[][]) {
  const sheets = getSheetsClient();
  const spreadsheetId = getBigdaySheetId();
  return sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: "RAW",
    requestBody: { values },
  });
}

async function sheetAppend(range: string, values: any[][]) {
  const sheets = getSheetsClient();
  const spreadsheetId = getBigdaySheetId();
  return sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });
}

async function sheetClear(range: string) {
  const sheets = getSheetsClient();
  const spreadsheetId = getBigdaySheetId();
  return sheets.spreadsheets.values.clear({ spreadsheetId, range });
}


async function getEventStatus(): Promise<"open" | "ended" | "closed" | ""> {
  const res = await sheetGet("Event!A2:A2");
  const v = res.data.values?.[0]?.[0];
  return (typeof v === "string" ? v.trim().toLowerCase() : "") as any;
}

async function setEvent(status: "open" | "ended" | "closed") {
  // Event: status | opened_at | ended_at
  const opened = status === "open" ? nowIso() : "";
  const ended = status === "ended" ? nowIso() : "";
  // Keep opened_at if ending? We'll preserve it by reading first.
  if (status === "ended") {
    const prev = await sheetGet("Event!A2:C2");
    const prevOpened = prev.data.values?.[0]?.[1] ?? "";
    await sheetUpdate("Event!A2:C2", [[status, prevOpened || "", ended]]);
    return;
  }
  await sheetUpdate("Event!A2:C2", [[status, opened, ended]]);
}

type ChecklistView = {
  subId?: string;
  obsDt?: string; // "YYYY-MM-DD HH:mm"
  creationDt?: string;
  protocolId?: string;
  durationHrs?: number;
  distKm?: number;
  distanceKm?: number;
  effortDistanceKm?: number;
  obs?: Array<{
    speciesCode?: string;
    // comName/sciName are not always included in this endpoint response
    comName?: string;
    sciName?: string;
    present?: boolean;
  }>;
};

async function fetchChecklist(subId: string): Promise<ChecklistView> {
  const token = getEbirdToken();
  if (!token) throw new Error("Missing EBIRD_API_TOKEN (or EBIRD_API_KEY) env var for /bigday submit.");

  const url = `https://api.ebird.org/v2/product/checklist/view/${encodeURIComponent(subId)}`;

  const res = await fetch(url, {
    headers: {
      "X-eBirdApiToken": token,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`eBird API error (${res.status}): ${text || res.statusText}`);
  }

  return (await res.json()) as ChecklistView;
}

class BigdaySubmitDto {
  @StringOption({
    name: "checklist_link",
    description: "Your eBird checklist link (it will NOT be shown publicly)",
    required: true,
  })
  checklist_link!: string;
}

@Injectable()
@SlashCommand({
  name: "bigday",
  description: "Big Day tools",
})
export class BigdayCommand {
  @Subcommand({
    name: "open",
    description: "Open Big Day submissions (mods only)",
  })
  public async onOpen(@Context() [interaction]: SlashCommandContext) {
    const gate = assertMod(interaction);
    if (gate) return interaction.reply({ ephemeral: true, content: gate });

    try {
      const status = await getEventStatus();
      if (status === "open") {
        return interaction.reply({
          ephemeral: true,
          content: "⚠️ Big Day already in progress.",
        });
      }

      await setEvent("open");

      return interaction.reply({
        ephemeral: false,
        content: "✅ Big Day is now **OPEN**.",
      });
    } catch (err: any) {
      const msg = typeof err?.message === "string" ? err.message : "Unknown error";
      return interaction.reply({ ephemeral: true, content: `❌ Failed to open Big Day: ${msg}` });
    }
  }

  @Subcommand({
    name: "end",
    description: "End Big Day submissions (mods only)",
  })
  public async onEnd(@Context() [interaction]: SlashCommandContext) {
    const gate = assertMod(interaction);
    if (gate) return interaction.reply({ ephemeral: true, content: gate });

    try {
      const status = await getEventStatus();
      if (status !== "open") {
        return interaction.reply({
          ephemeral: true,
          content: "❌ No Big Day is currently open.",
        });
      }

      await setEvent("ended");

      return interaction.reply({
        ephemeral: false,
        content: "🛑 Big Day is now **ENDED**. Submissions are closed.",
      });
    } catch (err: any) {
      const msg = typeof err?.message === "string" ? err.message : "Unknown error";
      return interaction.reply({ ephemeral: true, content: `❌ Failed to end Big Day: ${msg}` });
    }
  }

  @Subcommand({
    name: "erase",
    description: "Erase the current Big Day stats (mods only)",
  })
  public async onErase(@Context() [interaction]: SlashCommandContext) {
    const gate = assertMod(interaction);
    if (gate) return interaction.reply({ ephemeral: true, content: gate });

    try {
      // Clear event row + data tabs (keep headers)
      await sheetUpdate("Event!A2:C2", [["closed", "", ""]]);

      // Clear everything from row 2 down (keep headers)
      await sheetClear("Submissions!A2:F");
      await sheetClear("Species!A2:C");
      await sheetClear("FirstSeen!A2:F");

      return interaction.reply({
        ephemeral: false,
        content: "🧽 Big Day data erased. Ready for the next Big Day.",
      });
    } catch (err: any) {
      const msg = typeof err?.message === "string" ? err.message : "Unknown error";
      return interaction.reply({ ephemeral: true, content: `❌ Failed to erase Big Day: ${msg}` });
    }
  }

  @Subcommand({
    name: "submit",
    description: "Submit an eBird checklist (the link will not be shown publicly)",
  })
  public async onSubmit(
    @Context() [interaction]: SlashCommandContext,
    @Options() dto: BigdaySubmitDto,
  ) {
    // MUST be non-ephemeral per your requirements (but we will not show the link).
    // We'll use ephemeral only for internal errors we don't want to spam; you asked non-ephemeral
    // success/failure message, so we keep it non-ephemeral even on failure.
    try {
      const status = await getEventStatus();
      if (status !== "open") {
        return interaction.reply({
          ephemeral: false,
          content: "❌ Big Day submissions are not open right now.",
        });
      }

      const subId = extractChecklistSubId(dto.checklist_link);
      if (!subId) {
        return interaction.reply({
          ephemeral: false,
          content: "❌ I couldn’t find a checklist ID in that link. Make sure it contains something like `S123456789`.",
        });
      }

      // Dedup by checklist_id in Submissions tab
      const existingRes = await sheetGet("Submissions!A2:A");
      const existingIds = new Set(
        (existingRes.data.values ?? [])
          .map((r) => (typeof r?.[0] === "string" ? r[0].trim().toUpperCase() : ""))
          .filter(Boolean),
      );
      if (existingIds.has(subId)) {
        return interaction.reply({
          ephemeral: false,
          content: "⚠️ That checklist was already submitted.",
        });
      }

      const checklist = await fetchChecklist(subId);
      const obs = Array.isArray(checklist.obs) ? checklist.obs : [];

      // Pull out species codes; ignore empty.
      const speciesCodes = Array.from(
        new Set(
          obs
            .map((o) => (typeof o?.speciesCode === "string" ? o.speciesCode.trim() : ""))
            .filter(Boolean),
        ),
      );

      if (speciesCodes.length === 0) {
        return interaction.reply({
          ephemeral: false,
          content: "❌ I fetched the checklist but didn’t find any species in it.",
        });
      }

      // FirstSeen existing set
      const firstSeenRes = await sheetGet("FirstSeen!A2:A");
      const firstSeenCodes = new Set(
        (firstSeenRes.data.values ?? [])
          .map((r) => (typeof r?.[0] === "string" ? r[0].trim() : ""))
          .filter(Boolean),
      );

      // Identify new species
      const newSpecies = speciesCodes.filter((c) => !firstSeenCodes.has(c));
      const addedCount = newSpecies.length;

      const discordUserId = interaction.user.id;
      const discordUsername = interaction.user.username;

      // observed_at + distance_km from checklist (best-effort)
      const observedAt = checklist.obsDt ?? checklist.creationDt ?? "";
      const distanceKm =
        parseNumberLoose((checklist as any).distKm) ??
        parseNumberLoose((checklist as any).distanceKm) ??
        parseNumberLoose((checklist as any).effortDistanceKm);

      // Append submission
      await sheetAppend("Submissions!A:F", [
        [subId, discordUserId, discordUsername, observedAt, distanceKm ?? "", nowIso()],
      ]);

      // Append species rows (species name optional; we store code as name fallback)
      await sheetAppend(
        "Species!A:C",
        speciesCodes.map((code) => [subId, code, code]),
      );

      // Append FirstSeen rows for new species
      if (newSpecies.length > 0) {
        await sheetAppend(
          "FirstSeen!A:F",
          newSpecies.map((code) => [code, code, discordUserId, discordUsername, observedAt || nowIso(), subId]),
        );
      }

      return interaction.reply({
        ephemeral: false,
        content: `✅ Checklist accepted. You added **${addedCount}** new species.`,
      });
    } catch (err: any) {
      const msg = typeof err?.message === "string" ? err.message : "Unknown error";
      return interaction.reply({
        ephemeral: false,
        content: `❌ Submission failed: ${msg}`,
      });
    }
  }

  @Subcommand({
    name: "stats",
    description: "Show Big Day totals",
  })
  public async onStats(@Context() [interaction]: SlashCommandContext) {
    try {
      const status = await getEventStatus();

      const submissionsRes = await sheetGet("Submissions!A2:F");
      const submissions = submissionsRes.data.values ?? [];

      const firstSeenRes = await sheetGet("FirstSeen!A2:F");
      const firstSeen = firstSeenRes.data.values ?? [];

      const totalSpecies = firstSeen.length;

      const totalChecklists = submissions.length;

      const participants = new Set(
        submissions
          .map((r) => (typeof r?.[1] === "string" ? r[1].trim() : "")) // discord_user_id
          .filter(Boolean),
      );

      let totalDistance = 0;
      for (const r of submissions) {
        const km = parseNumberLoose(r?.[4]);
        if (km !== null) totalDistance += km;
      }

      const lines: string[] = [];
      lines.push(`**Status:** ${status === "open" ? "🟢 Open" : status === "ended" ? "🔴 Ended" : "⚪ Closed"}`);
      lines.push(`**Species:** ${totalSpecies}`);
      lines.push(`**Checklists:** ${totalChecklists}`);
      lines.push(`**Participants:** ${participants.size}`);
      lines.push(`**Distance:** ${Math.round(totalDistance * 10) / 10} km`);

      return interaction.reply({
        ephemeral: false,
        content: lines.join("\n"),
      });
    } catch (err: any) {
      const msg = typeof err?.message === "string" ? err.message : "Unknown error";
      return interaction.reply({ ephemeral: true, content: `❌ Failed to load stats: ${msg}` });
    }
  }

  @Subcommand({
    name: "species",
    description: "List species and who first logged them",
  })
  public async onSpecies(@Context() [interaction]: SlashCommandContext) {
    try {
      const res = await sheetGet("FirstSeen!A2:F");
      const rows = res.data.values ?? [];

      if (rows.length === 0) {
        return interaction.reply({ ephemeral: false, content: "No species have been submitted yet." });
      }

      // Sort by first_seen_at if available, else by species code
      rows.sort((a, b) => {
        const ta = typeof a?.[4] === "string" ? a[4] : "";
        const tb = typeof b?.[4] === "string" ? b[4] : "";
        if (ta && tb) return ta.localeCompare(tb);
        const sa = typeof a?.[0] === "string" ? a[0] : "";
        const sb = typeof b?.[0] === "string" ? b[0] : "";
        return sa.localeCompare(sb);
      });

      // Discord message length is limited; chunk the output.
      const lines = rows.map((r) => {
        const code = r?.[0] ?? "";
        const name = r?.[1] ?? code;
        const who = r?.[3] ?? "unknown";
        const when = r?.[4] ?? "";
        return `• **${name}** — first by **${who}**${when ? ` (${when})` : ""}`;
      });

      const MAX = 1800;
      let buf = "";
      const chunks: string[] = [];
      for (const line of lines) {
        if (buf.length + line.length + 1 > MAX) {
          chunks.push(buf);
          buf = "";
        }
        buf += (buf ? "\n" : "") + line;
      }
      if (buf) chunks.push(buf);

      // Send first chunk as reply, others as follow-ups
      await interaction.reply({ ephemeral: false, content: chunks[0] });
      for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp({ ephemeral: false, content: chunks[i] });
      }
    } catch (err: any) {
      const msg = typeof err?.message === "string" ? err.message : "Unknown error";
      return interaction.reply({ ephemeral: true, content: `❌ Failed to load species: ${msg}` });
    }
  }
}
