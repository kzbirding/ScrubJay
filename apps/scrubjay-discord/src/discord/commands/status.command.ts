import { Injectable } from "@nestjs/common";
import { EmbedBuilder } from "discord.js";
import {
  Context,
  Options,
  SlashCommand,
  SlashCommandContext,
  StringOption,
} from "necord";
import { REGION_MAP } from "./region-map";

class StatusOptions {
  @StringOption({
    name: "bird",
    description: "Bird name (ex: Mourning Dove)",
    required: true,
  })
  bird!: string;

  @StringOption({
    name: "region",
    description: "Region (ex: San Diego)",
    required: true,
  })
  region!: string;
}

type TaxonRow = {
  speciesCode?: string;
  comName?: string;
  sciName?: string;
  category?: string; // "species", etc.
};

@Injectable()
export class StatusCommand {
  @SlashCommand({
    name: "status",
    description: "Show recent eBird status for a bird in a region",
  })
  public async status(
    @Context() [interaction]: SlashCommandContext,
    @Options() options: StatusOptions,
  ) {
    const birdNameInput = options.bird.trim();
    const birdKey = birdNameInput.toLowerCase();

    const regionKey = options.region.toLowerCase().trim();
    const region =
      REGION_MAP[regionKey] ||
      REGION_MAP[regionKey.replace(" county", "").trim()] ||
      REGION_MAP[regionKey.replace("county", "").trim()];

    if (!region) {
      await interaction.reply({
        content:
          "❌ Unknown region. Try: San Diego, Orange County, Los Angeles, Riverside, San Bernardino, Imperial.",
        ephemeral: true,
      });
      return;
    }

    const token = process.env.ebird_token;
    if (!token) {
      await interaction.reply({
        content: "❌ ebird_token is not set on the server (Railway Variables).",
        ephemeral: true,
      });
      return;
    }

    // 1) Resolve bird name -> speciesCode via taxonomy
    // (Later we will cache this so it’s instant.)
    const taxUrl = `https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json&locale=en`;
    let taxRes: Response;
    try {
      taxRes = await fetch(taxUrl, { headers: { "X-eBirdApiToken": token } });
    } catch (err) {
      console.error("Taxonomy fetch failed:", err);
      await interaction.reply({
        content: "❌ Network error while contacting eBird taxonomy.",
        ephemeral: true,
      });
      return;
    }

    if (!taxRes.ok) {
      const body = await taxRes.text().catch(() => "");
      console.error("Taxonomy response not ok:", taxRes.status, body);
      await interaction.reply({
        content: `❌ eBird taxonomy error: HTTP ${taxRes.status}`.slice(0, 1900),
        ephemeral: true,
      });
      return;
    }

    const taxonomy: TaxonRow[] = await taxRes.json();

    const match = taxonomy.find(
      (t) =>
        t.category === "species" &&
        (t.comName ?? "").toLowerCase() === birdKey &&
        !!t.speciesCode,
    );

    if (!match?.speciesCode) {
      await interaction.reply({
        content: `❌ Couldn't find that bird in eBird taxonomy: "${birdNameInput}". Try a full common name (ex: "Mourning Dove").`,
        ephemeral: true,
      });
      return;
    }

    const speciesCode = match.speciesCode;
    const displayName = match.comName ?? birdNameInput;

    // 2) Query the correct endpoint: recent observations for THIS SPECIES in THIS REGION
    const obsUrl = `https://api.ebird.org/v2/data/obs/${region.code}/recent/${speciesCode}?back=30`;

    let res: Response;
    try {
      res = await fetch(obsUrl, {
        headers: { "X-eBirdApiToken": token },
      });
    } catch (err) {
      console.error("eBird obs fetch threw:", err);
      await interaction.reply({
        content: "❌ Network error while contacting eBird observations.",
        ephemeral: true,
      });
      return;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("eBird obs response not ok:", res.status, body);
      await interaction.reply({
        content: `❌ eBird error: HTTP ${res.status}${
          body ? `\nDetails: ${body}` : ""
        }`.slice(0, 1900),
        ephemeral: true,
      });
      return;
    }

    const data: any[] = await res.json();
    const count = data.length;

    let status = "🔴 Rare or absent";
    if (count >= 50) status = "🟢 Very common";
    else if (count >= 15) status = "🟢 Common";
    else if (count >= 5) status = "🟡 Uncommon";
    else if (count >= 1) status = "🟠 Scarce";

    let lastReported = "—";
    if (count > 0) {
      // obsDt is like "2026-01-04 09:20"
      lastReported = data
        .map((o) => o.obsDt)
        .filter(Boolean)
        .sort()
        .reverse()[0];
    }

    // Simple trend: last 15 days vs previous 15 days (based on obsDt date portion)
    const today = new Date();
    const daysAgo = (d: Date) =>
      Math.floor((today.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));

    let last15 = 0;
    let prev15 = 0;

    for (const o of data) {
      const dtStr: string | undefined = o.obsDt;
      if (!dtStr) continue;
      const datePart = dtStr.split(" ")[0]; // YYYY-MM-DD
      const d = new Date(datePart + "T00:00:00");
      const ago = daysAgo(d);
      if (ago < 0 || ago > 30) continue;
      if (ago <= 15) last15 += 1;
      else prev15 += 1;
    }

    let trend = "➖ Stable";
    if (last15 > prev15 * 1.25) trend = "📈 Increasing";
    else if (prev15 > last15 * 1.25) trend = "📉 Decreasing";

    const embed = new EmbedBuilder()
      .setTitle(displayName)
      .setDescription(region.label)
      .addFields(
        { name: "Status (30 days)", value: status, inline: true },
        { name: "Recent locations", value: String(count), inline: true },
        { name: "Last reported", value: lastReported, inline: true },
        { name: "Trend", value: trend, inline: true },
      )
      .setFooter({ text: "Source: eBird (last 30 days)" });

    await interaction.reply({ embeds: [embed] });
  }
}
