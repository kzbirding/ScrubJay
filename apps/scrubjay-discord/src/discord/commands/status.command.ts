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
    const birdName = options.bird.trim();
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

    const token = process.env.EBIRD_TOKEN;
    if (!token) {
      await interaction.reply({
        content:
          "❌ EBIRD_TOKEN is not set on the server. It should already exist if other eBird commands work.",
        ephemeral: true,
      });
      return;
    }

    const url = `https://api.ebird.org/v2/data/obs/${region.code}/recent?back=30`;

    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          "X-eBirdApiToken": token,
        },
      });
    } catch (err) {
      console.error("eBird fetch threw:", err);
      await interaction.reply({
        content: "❌ Network error while contacting eBird (fetch failed).",
        ephemeral: true,
      });
      return;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("eBird response not ok:", res.status, body);

      await interaction.reply({
        content: `❌ eBird error: HTTP ${res.status}${
          body ? `\nDetails: ${body}` : ""
        }`.slice(0, 1900),
        ephemeral: true,
      });
      return;
    }

    const data: any[] = await res.json();

    const matches = data.filter(
      (o) => (o.comName ?? "").toLowerCase() === birdName.toLowerCase(),
    );

    const count = matches.length;

    let status = "🔴 Rare or absent";
    if (count >= 50) status = "🟢 Very common";
    else if (count >= 15) status = "🟢 Common";
    else if (count >= 5) status = "🟡 Uncommon";
    else if (count >= 1) status = "🟠 Scarce";

    let lastReported = "—";
    if (count > 0) {
      lastReported = matches
        .map((o) => o.obsDt)
        .filter(Boolean)
        .sort()
        .reverse()[0];
    }

    const embed = new EmbedBuilder()
      .setTitle(birdName)
      .setDescription(region.label)
      .addFields(
        { name: "Status (30 days)", value: status, inline: true },
        { name: "Recent locations", value: String(count), inline: true },
        { name: "Last reported", value: lastReported, inline: true },
      )
      .setFooter({ text: "Source: eBird (last 30 days)" });

    await interaction.reply({ embeds: [embed] });
  }
}
