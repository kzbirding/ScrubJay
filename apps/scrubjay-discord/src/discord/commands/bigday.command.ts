import { Injectable } from "@nestjs/common";
import {
  SlashCommand,
  SlashCommandContext,
  Subcommand,
  Context,
  Options,
} from "necord";
import { ChatInputCommandInteraction } from "discord.js";

import { StringOption } from "necord";
import { IsString } from "class-validator";

class BigdaySubmitDto {
  @StringOption({
    name: "checklist",
    description: "eBird checklist link or ID (e.g., S123456789)",
    required: true,
  })
  @IsString()
  checklist!: string;
}


import { getBigdaySheetId, getSheetsClient } from "@/sheets/sheets.client";
import { EbirdTaxonomyService } from "./ebird-taxonomy.service";

function nowIso() {
  return new Date().toISOString();
}

function extractChecklistId(input: unknown): string | null {
  if (typeof input !== "string") return null;
  // supports full URL or raw checklist id (S123456789)
  const m = input.match(/S\d+/i);
  return m ? m[0].toUpperCase() : null;
}

function extractISODateFromObservedAt(observedAt: string): string | null {
  const raw = (observedAt ?? "").trim();
  if (!raw) return null;

  // eBird commonly returns: "YYYY-MM-DD HH:MM"
  const m1 = raw.match(/(\d{4}-\d{2}-\d{2})/);
  if (m1) return m1[1];

  // Fallback: MM/DD/YYYY (US)
  const m2 = raw.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (m2) {
    const mm = Number(m2[1]);
    const dd = Number(m2[2]);
    const yyyy = Number(m2[3]);
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);
      return `${yyyy}-${pad2(mm)}-${pad2(dd)}`;
    }
  }

  return null;
}


@Injectable()
@SlashCommand({
  name: "bigday",
  description: "Big Day tools",
})
export class BigdayCommand {
  constructor(private readonly taxonomy: EbirdTaxonomyService) {}

  // -----------------------
  // /bigday open
  // -----------------------
  @Subcommand({
    name: "open",
    description: "Open Big Day submissions (mod only)",
  })
  public async onOpen(@Context() [interaction]: SlashCommandContext) {
    const member = interaction.member;
    const modRoleId = process.env.MOD_ID;

    if (
      !modRoleId ||
      !member ||
      !("roles" in member) ||
      !("cache" in member.roles) || !member.roles.cache.has(modRoleId)
    ) {
      return interaction.reply({
        ephemeral: true,
        content: "❌ You do not have permission to open a Big Day.",
      });
    }

    try {
      const sheets = getSheetsClient();
      const spreadsheetId = getBigdaySheetId();

      const current = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: "Event!A2",
      });

      const status = current.data.values?.[0]?.[0];
      if (status === "open") {
        return interaction.reply({
          ephemeral: true,
          content: "⚠️ Big Day already in progress.",
        });
      }

      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: "Event!A2:C2",
        valueInputOption: "RAW",
        requestBody: {
          values: [["open", nowIso(), ""]],
        },
      });

      return interaction.reply({
        ephemeral: false,
        content: "✅ Big Day is now **OPEN**.",
      });
    } catch (err: any) {
      return interaction.reply({
        ephemeral: true,
        content: `❌ Failed to open Big Day: ${err?.message ?? "unknown error"}`,
      });
    }
  }

  // -----------------------
  // /bigday end
  // -----------------------
  @Subcommand({
    name: "end",
    description: "End Big Day submissions (mod only)",
  })
  public async onEnd(@Context() [interaction]: SlashCommandContext) {
    const member = interaction.member;
    const modRoleId = process.env.MOD_ID;

    if (
      !modRoleId ||
      !member ||
      !("roles" in member) ||
      !("cache" in member.roles) || !member.roles.cache.has(modRoleId)
    ) {
      return interaction.reply({
        ephemeral: true,
        content: "❌ You do not have permission to end a Big Day.",
      });
    }

    try {
      const sheets = getSheetsClient();
      const spreadsheetId = getBigdaySheetId();

      const current = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: "Event!A2",
      });

      const status = current.data.values?.[0]?.[0];
      if (status !== "open") {
        return interaction.reply({
          ephemeral: true,
          content: "⚠️ No Big Day is currently in progress.",
        });
      }

      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: "Event!A2:E2",
        valueInputOption: "RAW",
        requestBody: {
          values: [["ended", "", nowIso(), "", ""]],
        },
      });

      return interaction.reply({
        ephemeral: false,
        content: "🛑 Big Day has been **ENDED**.",
      });
    } catch (err: any) {
      return interaction.reply({
        ephemeral: true,
        content: `❌ Failed to end Big Day: ${err?.message ?? "unknown error"}`,
      });
    }
  }

  // -----------------------
  // /bigday submit
  // -----------------------
  @Subcommand({
    name: "submit",
    description: "Submit an eBird checklist to the Big Day",
  })
  public async onSubmit(
    @Context() [interaction]: SlashCommandContext,
    @Options() options: BigdaySubmitDto,
  ) {
    const checklistInput = options.checklist;

    const checklistId = extractChecklistId(checklistInput);
    if (!checklistId) {
      return interaction.reply({
        ephemeral: true,
        content: "❌ Invalid checklist link or ID.",
      });
    }

    try {
      const sheets = getSheetsClient();
      const spreadsheetId = getBigdaySheetId();

      // check event open + read allowed date range (Event!D2:E2)
      const ev = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: "Event!A2:E2",
      });

      const evRow = ev.data.values?.[0] ?? [];
      const status = evRow[0];
      const allowedStart = (evRow[3] ?? "").toString().trim();
      const allowedEnd = (evRow[4] ?? "").toString().trim();

      if (status !== "open") {
        return interaction.reply({
          ephemeral: true,
          content: "⚠️ Big Day is not currently open.",
        });
      }

      if (!allowedStart || !allowedEnd) {
        return interaction.reply({
          ephemeral: true,
          content:
            "⚠️ Big Day dates are not set. A mod must run `/bigday open` with a start and end date.",
        });
      }

      // check duplicate submission
      const subs = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: "Submissions!A2:A",
      });

      const existing = new Set(
        (subs.data.values ?? []).map((r) => r[0]),
      );

      if (existing.has(checklistId)) {
        return interaction.reply({
          ephemeral: true,
          content: "⚠️ That checklist has already been submitted.",
        });
      }

      // fetch checklist from eBird
      const token =
        process.env.EBIRD_TOKEN || process.env.EBIRD_TOKEN;
      if (!token) {
        throw new Error("Missing EBIRD API token");
      }

      const res = await fetch(
        `https://api.ebird.org/v2/product/checklist/view/${checklistId}`,
        {
          headers: { "X-eBirdApiToken": token },
        },
      );

      if (!res.ok) {
        throw new Error("Failed to fetch checklist from eBird");
      }

      const data: any = await res.json();
      const taxa: string[] = (data.obs ?? [])
        .map((o: any) => o.speciesCode)
        .filter(Boolean);

        await this.taxonomy.ensureLoaded();

      const observedAt = data.obsDt ?? "";

      // Enforce checklist date range (America/Los_Angeles / SoCal)
      const checklistDate = extractISODateFromObservedAt(observedAt);
      if (!checklistDate) {
        return interaction.reply({
          ephemeral: true,
          content:
            "❌ Could not determine the checklist date from eBird. Please try a different checklist.",
        });
      }

      // Compare YYYY-MM-DD strings (lexicographic works for ISO dates)
      if (checklistDate < allowedStart || checklistDate > allowedEnd) {
        return interaction.reply({
          ephemeral: true,
          content:
            `❌ Checklist date **${checklistDate}** is outside the allowed Big Day range (**${allowedStart}** to **${allowedEnd}**).`,
        });
      }
      const kmRaw =
        data.distanceKm ??
        data.subAux?.effortDistanceKm ??
        data.subAux?.distKm;

      const distanceKm =
        kmRaw === undefined || kmRaw === null || kmRaw === ""
          ? ""
          : Number(kmRaw);


      const discordUserId = interaction.user.id;
      const discordUsername = interaction.user.username;

      // write submission
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: "Submissions!A:F",
        valueInputOption: "RAW",
        requestBody: {
          values: [[
            checklistId,
            discordUserId,
            discordUsername,
            observedAt,
            distanceKm,
            nowIso(),
          ]],
        },
      });

      // write species + first-seen
      const firstSeenRes = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: "FirstSeen!A2:A",
      });
      const alreadySeen = new Set(
        (firstSeenRes.data.values ?? []).map((r) => r[0]),
      );

      let newCount = 0;
      const speciesRows: any[] = [];
      const firstSeenRows: any[] = [];

      for (const code of taxa) {
        const common =
          this.taxonomy.lookupBySpeciesCode(code)?.comName ?? code;

        speciesRows.push([checklistId, code, common]);

        if (!alreadySeen.has(code)) {
          alreadySeen.add(code);
          newCount++;
          firstSeenRows.push([
            code,
            common,
            discordUserId,
            discordUsername,
            observedAt,
            checklistId,
          ]);
        }
      }

      if (speciesRows.length) {
        await sheets.spreadsheets.values.append({
          spreadsheetId,
          range: "Species!A:C",
          valueInputOption: "RAW",
          requestBody: { values: speciesRows },
        });
      }

      if (firstSeenRows.length) {
        await sheets.spreadsheets.values.append({
          spreadsheetId,
          range: "FirstSeen!A:F",
          valueInputOption: "RAW",
          requestBody: { values: firstSeenRows },
        });
      }

      return interaction.reply({
        ephemeral: false,
        content: `✅ Checklist accepted. You added **${newCount}** new species to the Big Day.`,
      });
    } catch (err: any) {
      return interaction.reply({
        ephemeral: true,
        content: `❌ Submission failed: ${err?.message ?? "unknown error"}`,
      });
    }
  }

    @Subcommand({
    name: "stats",
    description: "Show Big Day totals",
  })
  public async onStats(@Context() [interaction]: SlashCommandContext) {
    try {
      const sheets = getSheetsClient();
      const spreadsheetId = getBigdaySheetId();

      const [eventRes, subsRes, firstRes] = await Promise.all([
        sheets.spreadsheets.values.get({ spreadsheetId, range: "Event!A2:C2" }),
        sheets.spreadsheets.values.get({ spreadsheetId, range: "Submissions!A2:F" }),
        sheets.spreadsheets.values.get({ spreadsheetId, range: "FirstSeen!A2:F" }),
      ]);

      const eventRow = eventRes.data.values?.[0] ?? [];
      const status = eventRow[0] ?? "closed";
      const openedAt = eventRow[1] ?? "";
      const endedAt = eventRow[2] ?? "";

      const subs = subsRes.data.values ?? [];
      const firstSeen = firstRes.data.values ?? [];

      const totalChecklists = subs.length;
      const uniqueParticipants = new Set(subs.map((r) => r[1]).filter(Boolean)).size;

      let totalDistanceKm = 0;

      for (const r of subs) {
        const v = r[4]; // distance_km column
        if (v === "" || v == null) continue;

        const n = Number(v);
        if (!Number.isNaN(n)) {
          totalDistanceKm += n;
        }
      }

      const totalMiles = totalDistanceKm * 0.621371;

      const totalSpecies = firstSeen.length;


      return interaction.reply({
        ephemeral: true,
        content:
          `**Big Day Stats**\n` +
          `• Status: **${status}**\n` +
          (openedAt ? `• Opened: ${openedAt}\n` : "") +
          (endedAt ? `• Ended: ${endedAt}\n` : "") +
          `• Total species: **${totalSpecies}**\n` +
          `• Total distance: **${totalMiles.toFixed(1)} mi**\n` +
          `• Total checklists: **${totalChecklists}**\n` +
          `• Unique participants: **${uniqueParticipants}**`,
      });
    } catch (err: any) {
      return interaction.reply({
        ephemeral: true,
        content: `❌ Failed to load stats: ${err?.message ?? "unknown error"}`,
      });
    }
  }

    @Subcommand({
    name: "species",
    description: "List all species and who got them first",
  })
  public async onSpecies(@Context() [interaction]: SlashCommandContext) {
    try {
      const sheets = getSheetsClient();
      const spreadsheetId = getBigdaySheetId();

      const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: "FirstSeen!A2:F",
      });

      const rows = res.data.values ?? [];
      if (!rows.length) {
        return interaction.reply({
          ephemeral: true,
          content: "No species have been recorded yet.",
        });
      }

      // Columns: taxon_code | species_name | first_seen_by_user_id | first_seen_by_username | first_seen_at | first_checklist_id
      const lines = rows.map((r, i) => {
        const name = r[1] ?? r[0] ?? "(unknown)";
        const who = r[3] ?? "(unknown)";
        const when = r[4] ?? "";
        return `${i + 1}. ${name} — **${who}**${when ? ` (${when})` : ""}`;
      });

      // Discord message size safety: chunk into multiple replies
      const chunks: string[] = [];
      let cur = "**Big Day Species (first seen)**\n";
      for (const line of lines) {
        if ((cur + line + "\n").length > 1800) {
          chunks.push(cur);
          cur = "";
        }
        cur += line + "\n";
      }
      if (cur.trim()) chunks.push(cur);

      // first message normal reply, rest follow-ups
      await interaction.reply({ ephemeral: true, content: chunks[0] });
      for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp({ ephemeral: true, content: chunks[i] });
      }
    } catch (err: any) {
      return interaction.reply({
        ephemeral: true,
        content: `❌ Failed to load species: ${err?.message ?? "unknown error"}`,
      });
    }
  }

  @Subcommand({
  name: "erase",
  description: "Erase all Big Day data (mods only)",
})
public async onErase(@Context() [interaction]: SlashCommandContext) {
  const member = interaction.member;
  const modRoleId = process.env.MOD_ID;

  if (
    !modRoleId ||
    !member ||
    !("roles" in member) ||
    !("cache" in member.roles) ||
    !member.roles.cache.has(modRoleId)
  ) {
    return interaction.reply({
      ephemeral: true,
      content: "❌ You do not have permission to erase Big Day data.",
    });
  }

  try {
    const sheets = getSheetsClient();
    const spreadsheetId = getBigdaySheetId();

    // Clear data rows (keep headers)
    await Promise.all([
      sheets.spreadsheets.values.clear({
        spreadsheetId,
        range: "Species!A2:Z",
      }),
      sheets.spreadsheets.values.clear({
        spreadsheetId,
        range: "FirstSeen!A2:Z",
      }),
      sheets.spreadsheets.values.clear({
        spreadsheetId,
        range: "Submissions!A2:Z",
      }),
      sheets.spreadsheets.values.update({
        spreadsheetId,
        range: "Event!A2:E2",
        valueInputOption: "RAW",
        requestBody: {
          values: [["closed", "", "", "", ""]],
        },
      }),
    ]);

    return interaction.reply({
      ephemeral: true,
      content: "🧹 **Big Day data erased.** Ready for a fresh start.",
    });
  } catch (err: any) {
    return interaction.reply({
      ephemeral: true,
      content: `❌ Failed to erase Big Day data: ${err?.message ?? "unknown error"}`,
    });
  }
}

}
