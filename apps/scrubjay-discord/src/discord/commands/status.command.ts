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
    description: "Bird name (ex: California Gnatcatcher)",
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

    const region = REGION_MAP[regionKey];
    if (!region) {
      await interaction.reply({
        content: "❌ Unknown region. Try: San Diego, Orange County, LA, Riverside.",
        ephemeral: true,
      });
      return;
    }

    const url = `https://api.ebird.org/v2/data/obs/${region.code}/recent?back=30`;

    const res = await fetch(url, {
      headers: {
        "X-eBirdApiToken": process.env.EBIRD_API_KEY!,
      },
    });

    if (!res.ok) {
      await interaction.reply({
        content: "❌ Failed to fetch eBird data.",
        ephemeral: true,
      });
      return;
    }

    const data: any[] = await res.json();

    const matches = data.filter(
      (o) => o.comName?.toLowerCase() === birdName.toLowerCase(),
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
