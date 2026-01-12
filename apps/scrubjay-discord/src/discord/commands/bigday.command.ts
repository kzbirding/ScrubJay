import { Injectable } from "@nestjs/common";
import {
  SlashCommand,
  SlashCommandContext,
  Subcommand,
  Context,
  Options,
} from "necord";
import { ChatInputCommandInteraction } from "discord.js";

import { getBigdaySheetId, getSheetsClient } from "@/sheets/sheets.client";
import { EbirdTaxonomyService } from "./ebird-taxonomy.service";

function nowIso() {
  return new Date().toISOString();
}

function extractChecklistId(input: string): string | null {
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
    @Options("checklist") checklistInput: string,
  ) {
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
          ephemeral: false,
          content: "⚠️ That checklist has already been submitted.",
        });
      }

      // fetch checklist from eBird
      const token =
        process.env.EBIRD_API_TOKEN || process.env.EBIRD_API_KEY;
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

      const observedAt = data.obsDt ?? "";
      const distanceKm =
        typeof data.distanceKm === "number" ? data.distanceKm : "";

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
}
