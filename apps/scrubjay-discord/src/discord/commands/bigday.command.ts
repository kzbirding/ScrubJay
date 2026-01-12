import { Injectable } from "@nestjs/common";
import { SlashCommand, SlashCommandContext, Subcommand, Context } from "necord";

import { getBigdaySheetId, getSheetsClient } from "@/sheets/sheets.client";

function nowIso() {
  return new Date().toISOString();
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
    // NOTE: We'll add a proper mod check once we confirm Sheets writes work.
    // For now, this just tests your Sheets setup end-to-end.

    const sheets = getSheetsClient();
    const spreadsheetId = getBigdaySheetId();

    try {
      // Writes row 2 (under headers) in the "Event" tab:
      // status | opened_at | ended_at
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
        content: "✅ Big Day is now **OPEN**. (Event tab updated)",
      });
    } catch (err: any) {
      const msg =
        typeof err?.message === "string" ? err.message : "Unknown error writing to Google Sheets";
      return interaction.reply({
        ephemeral: true,
        content: `❌ Failed to open Big Day: ${msg}`,
      });
    }
  }
}
