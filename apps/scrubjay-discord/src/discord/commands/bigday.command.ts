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

class BigdayOpenDto {
  @StringOption({
    name: "start",
    description: "Start date (e.g., 2026-01-12, 1/12/2026, Jan 12 2026)",
    required: true,
  })
  @IsString()
  start!: string;

  @StringOption({
    name: "end",
    description: "End date (e.g., 2026-01-12, 1/12/2026, Jan 12 2026)",
    required: true,
  })
  @IsString()
  end!: string;
}



import { getBigdaySheetId, getSheetsClient } from "@/sheets/sheets.client";
import { EbirdTaxonomyService } from "./ebird-taxonomy.service";

function nowIso() {
  return new Date().toISOString();
}


function pad2(n: number) {
  return n < 10 ? `0${n}` : `${n}`;
}

function parseUserDateToISODate(input: string): string | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;

  const s = raw.toLowerCase();

  // relative shortcuts (LA local date)
  const today = new Date();
  if (s === "today" || s === "tod") {
    return `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;
  }
  if (s === "tomorrow" || s === "tmr" || s === "tomm") {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  if (s === "yesterday" || s === "yest") {
    const d = new Date(today);
    d.setDate(d.getDate() - 1);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  // YYYY-MM-DD
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const yyyy = Number(m[1]);
    const mm = Number(m[2]);
    const dd = Number(m[3]);
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) return `${yyyy}-${pad2(mm)}-${pad2(dd)}`;
    return null;
  }

  // MM/DD[/YYYY] or M-D-YYYY (assume US ordering)
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/);
  if (m) {
    const mm = Number(m[1]);
    const dd = Number(m[2]);
    let yyyy = m[3] ? Number(m[3]) : today.getFullYear();
    if (m[3] && m[3].length === 2) yyyy = 2000 + yyyy; // 24 -> 2024
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) return `${yyyy}-${pad2(mm)}-${pad2(dd)}`;
    return null;
  }

  const months: Record<string, number> = {
    jan: 1, january: 1,
    feb: 2, february: 2,
    mar: 3, march: 3,
    apr: 4, april: 4,
    may: 5,
    jun: 6, june: 6,
    jul: 7, july: 7,
    aug: 8, august: 8,
    sep: 9, sept: 9, september: 9,
    oct: 10, october: 10,
    nov: 11, november: 11,
    dec: 12, december: 12,
  };

  // "Jan 12 2026" / "January 12" / "12 Jan 2026"
  const parts = s.replace(/,/g, " ").split(/\s+/).filter(Boolean);
  if (parts.length >= 2 && parts.length <= 3) {
    const a = parts[0];
    const b = parts[1];
    const c = parts[2];

    const aMonth = months[a];
    const bMonth = months[b];

    // Month Day [Year]
    if (aMonth) {
      const dd = Number(b);
      let yyyy = c ? Number(c) : today.getFullYear();
      if (Number.isFinite(dd) && dd >= 1 && dd <= 31 && yyyy >= 1900 && yyyy <= 3000) {
        return `${yyyy}-${pad2(aMonth)}-${pad2(dd)}`;
      }
    }

    // Day Month [Year]
    if (bMonth) {
      const dd = Number(a);
      let yyyy = c ? Number(c) : today.getFullYear();
      if (Number.isFinite(dd) && dd >= 1 && dd <= 31 && yyyy >= 1900 && yyyy <= 3000) {
        return `${yyyy}-${pad2(bMonth)}-${pad2(dd)}`;
      }
    }
  }

  return null;
}
function extractChecklistId(input: unknown): string | null {
  if (typeof input !== "string") return null;
  // supports full URL or raw checklist id (S123456789)
  const m = input.match(/S\d+/i);
  return m ? m[0].toUpperCase() : null;
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
  public async onOpen(@Context() [interaction]: SlashCommandContext,
    @Options() options: BigdayOpenDto,
  ) {
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

      

      const startIso = parseUserDateToISODate(options?.start);
      const endIso = parseUserDateToISODate(options?.end);

      if (!startIso || !endIso) {
        return interaction.reply({
          ephemeral: true,
          content:
            "❌ Invalid date format. Examples: `2026-01-12`, `1/12/2026`, `Jan 12 2026`.",
        });
      }
      if (startIso > endIso) {
        return interaction.reply({
          ephemeral: true,
          content: "❌ Start date must be on or before the end date.",
        });
      }
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
        range: "Event!A2:E2",
        valueInputOption: "RAW",
        requestBody: {
          values: [["open", nowIso(), "", startIso, endIso]],
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
        range: "Event!A2:C2",
        valueInputOption: "RAW",
        requestBody: {
          values: [["ended", "", nowIso()]],
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

      // check event open
      const ev = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: "Event!A2",
      });

      if (ev.data.values?.[0]?.[0] !== "open") {
        return interaction.reply({
          ephemeral: true,
          content: "⚠️ Big Day is not currently open.",
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
        range: "Event!A2:C2",
        valueInputOption: "RAW",
        requestBody: {
          values: [["closed", "", ""]],
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
