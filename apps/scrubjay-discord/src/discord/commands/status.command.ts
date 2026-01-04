import { Injectable } from "@nestjs/common";
import { EmbedBuilder } from "discord.js";
import {
  Context,
  Options,
  SlashCommand,
  SlashCommandContext,
  StringOption,
} from "necord";
import { EbirdTaxonomyService } from "./ebird-taxonomy.service";

class StatusOptions {
  @StringOption({
    name: "bird",
    description: "Bird name (ex: Mourning Dove)",
    required: true,
  })
  bird!: string;

  @StringOption({
    name: "region",
    description: "County (San Diego, Imperial, Orange, Los Angeles, San Bernardino, Riverside)",
    required: true,
  })
  region!: string;
}

type EffortTier = "HIGH" | "MODERATE" | "LOW";

type CountyConfig = {
  code: string;
  label: string;
  tier: EffortTier;
};

const STATUS_COUNTIES: Record<string, CountyConfig> = {
  // San Diego (HIGH)
  "san diego": { code: "US-CA-073", label: "San Diego County, CA", tier: "HIGH" },
  "san diego county": { code: "US-CA-073", label: "San Diego County, CA", tier: "HIGH" },

  // Imperial (LOW)
  "imperial": { code: "US-CA-025", label: "Imperial County, CA", tier: "LOW" },
  "imperial county": { code: "US-CA-025", label: "Imperial County, CA", tier: "LOW" },

  // Orange (HIGH)
  "orange": { code: "US-CA-059", label: "Orange County, CA", tier: "HIGH" },
  "orange county": { code: "US-CA-059", label: "Orange County, CA", tier: "HIGH" },
  "oc": { code: "US-CA-059", label: "Orange County, CA", tier: "HIGH" },

  // Los Angeles (HIGH)
  "los angeles": { code: "US-CA-037", label: "Los Angeles County, CA", tier: "HIGH" },
  "los angeles county": { code: "US-CA-037", label: "Los Angeles County, CA", tier: "HIGH" },
  "la": { code: "US-CA-037", label: "Los Angeles County, CA", tier: "HIGH" },

  // San Bernardino (MODERATE)
  "san bernardino": { code: "US-CA-071", label: "San Bernardino County, CA", tier: "MODERATE" },
  "san bernardino county": { code: "US-CA-071", label: "San Bernardino County, CA", tier: "MODERATE" },
  "sb": { code: "US-CA-071", label: "San Bernardino County, CA", tier: "MODERATE" },

  // Riverside (MODERATE)
  "riverside": { code: "US-CA-065", label: "Riverside County, CA", tier: "MODERATE" },
  "riverside county": { code: "US-CA-065", label: "Riverside County, CA", tier: "MODERATE" },
};

function normalizeRegion(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Convert "recent reports in last 30 days" to a non-abundance label.
 * This is intentionally NOT "common/uncommon".
 *
 * Note: counts come from eBird "recent observations for species" endpoint,
 * which reflects recent report volume (and is influenced by birding effort).
 */
function labelForCount(tier: EffortTier, count: number): string {
  if (count <= 0) return "Not reported recently";

  // HIGH effort counties: require more reports to call it "frequent"
  if (tier === "HIGH") {
    if (count >= 200) return "Very frequently observed";
    if (count >= 80) return "Frequently observed";
    if (count >= 20) return "Regularly observed";
    if (count >= 5) return "Occasionally observed";
    return "Rarely observed";
  }

  // MODERATE effort counties
  if (tier === "MODERATE") {
    if (count >= 120) return "Very frequently observed";
    if (count >= 45) return "Frequently observed";
    if (count >= 12) return "Regularly observed";
    if (count >= 3) return "Occasionally observed";
    return "Rarely observed";
  }

  // LOW effort counties (Imperial): fewer total checklists, hotspot clustering
  if (count >= 60) return "Very frequently observed";
  if (count >= 20) return "Frequently observed";
  if (count >= 6) return "Regularly observed";
  if (count >= 2) return "Occasionally observed";
  return "Rarely observed";
}

function trendFromObsDates(data: any[]): string {
  // Simple trend: last 15 days vs previous 15 days
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

  if (last15 === 0 && prev15 === 0) return "—";
  if (last15 > prev15 * 1.25) return "📈 Increasing";
  if (prev15 > last15 * 1.25) return "📉 Decreasing";
  return "➖ Stable";
}

@Injectable()
export class StatusCommand {
  constructor(private readonly taxonomy: EbirdTaxonomyService) {}

  @SlashCommand({
    name: "status",
    description: "Show recent eBird status for a bird in a SoCal county",
  })
  public async status(
    @Context() [interaction]: SlashCommandContext,
    @Options() options: StatusOptions,
  ) {
    const birdNameInput = options.bird.trim();
    const regionKey = normalizeRegion(options.region);

    const county = STATUS_COUNTIES[regionKey];

    if (!county) {
      await interaction.reply({
        content:
          "❌ Unknown county for /status.\nAllowed: San Diego, Imperial, Orange County (OC), Los Angeles (LA), San Bernardino (SB), Riverside.",
        ephemeral: true,
      });
      return;
    }

    const token = process.env.EBIRD_TOKEN;
    if (!token) {
      await interaction.reply({
        content:
          "❌ EBIRD_TOKEN is not set on the server (Railway Variables).",
        ephemeral: true,
      });
      return;
    }

    if (!this.taxonomy.isLoaded()) {
      const err = this.taxonomy.getLoadError();
      await interaction.reply({
        content:
          `❌ Bird list isn’t loaded yet (startup). Try again in ~30 seconds.` +
          (err ? `\nDetails: ${err}` : ""),
        ephemeral: true,
      });
      return;
    }

    const entry = this.taxonomy.lookupCommonName(birdNameInput);
    if (!entry) {
      const suggestions = this.taxonomy.suggest(birdNameInput, 5);
      await interaction.reply({
        content:
          `❌ I couldn’t find "${birdNameInput}" in eBird’s bird list.` +
          (suggestions.length ? `\nDid you mean: ${suggestions.join(", ")}?` : ""),
        ephemeral: true,
      });
      return;
    }

    const { speciesCode, comName } = entry;

    // Correct endpoint: recent observations for THIS SPECIES in THIS REGION
    const obsUrl = `https://api.ebird.org/v2/data/obs/${county.code}/recent/${speciesCode}?back=30`;

    let res: Response;
    try {
      res = await fetch(obsUrl, {
        headers: { "X-eBirdApiToken": token },
      });
    } catch (err) {
      console.error("eBird obs fetch threw:", err);
      await interaction.reply({
        content: "❌ Network error while contacting eBird.",
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

    const frequencyLabel = labelForCount(county.tier, count);

    let lastReported = "—";
    if (count > 0) {
      lastReported = data
        .map((o) => o.obsDt)
        .filter(Boolean)
        .sort()
        .reverse()[0];
    }

    const trend = trendFromObsDates(data);

    const embed = new EmbedBuilder()
      .setTitle(comName)
      .setDescription(county.label)
      .addFields(
        { name: "Observation frequency (30 days)", value: frequencyLabel, inline: false },
        { name: "Recent reports (30 days)", value: String(count), inline: true },
        { name: "Last reported", value: lastReported, inline: true },
        { name: "Trend", value: trend, inline: true },
      )
      .setFooter({
        text: "Source: eBird (last 30 days). Labels reflect report frequency, not true abundance.",
      });

    await interaction.reply({ embeds: [embed] });
  }
}
