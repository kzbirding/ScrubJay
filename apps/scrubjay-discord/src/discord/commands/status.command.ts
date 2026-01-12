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
    description:
      "County (San Diego, Imperial, Orange, Los Angeles, San Bernardino, Riverside)",
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
  "san diego": { code: "US-CA-073", label: "San Diego County, CA", tier: "HIGH" },
  "san diego county": { code: "US-CA-073", label: "San Diego County, CA", tier: "HIGH" },

  imperial: { code: "US-CA-025", label: "Imperial County, CA", tier: "LOW" },
  "imperial county": { code: "US-CA-025", label: "Imperial County, CA", tier: "LOW" },

  orange: { code: "US-CA-059", label: "Orange County, CA", tier: "HIGH" },
  "orange county": { code: "US-CA-059", label: "Orange County, CA", tier: "HIGH" },
  oc: { code: "US-CA-059", label: "Orange County, CA", tier: "HIGH" },

  "los angeles": { code: "US-CA-037", label: "Los Angeles County, CA", tier: "HIGH" },
  "los angeles county": { code: "US-CA-037", label: "Los Angeles County, CA", tier: "HIGH" },
  la: { code: "US-CA-037", label: "Los Angeles County, CA", tier: "HIGH" },

  "san bernardino": { code: "US-CA-071", label: "San Bernardino County, CA", tier: "MODERATE" },
  "san bernardino county": { code: "US-CA-071", label: "San Bernardino County, CA", tier: "MODERATE" },
  sb: { code: "US-CA-071", label: "San Bernardino County, CA", tier: "MODERATE" },

  riverside: { code: "US-CA-065", label: "Riverside County, CA", tier: "MODERATE" },
  "riverside county": { code: "US-CA-065", label: "Riverside County, CA", tier: "MODERATE" },
};

function normalizeRegion(input: string): string {
  return input.toLowerCase().trim().replace(/\s+/g, " ");
}

function labelForCount(tier: EffortTier, count: number): string {
  if (count <= 0) return "🔴 Not reported recently";

  if (tier === "HIGH") {
    if (count >= 200) return "🟢 Very frequently observed";
    if (count >= 80) return "🟢 Frequently observed";
    if (count >= 20) return "🟡 Regularly observed";
    if (count >= 5) return "🟠 Occasionally observed";
    return "🔴 Rarely observed";
  }

  if (tier === "MODERATE") {
    if (count >= 120) return "🟢 Very frequently observed";
    if (count >= 45) return "🟢 Frequently observed";
    if (count >= 12) return "🟡 Regularly observed";
    if (count >= 3) return "🟠 Occasionally observed";
    return "🔴 Rarely observed";
  }

  if (count >= 60) return "🟢 Very frequently observed";
  if (count >= 20) return "🟢 Frequently observed";
  if (count >= 6) return "🟡 Regularly observed";
  if (count >= 2) return "🟠 Occasionally observed";
  return "🔴 Rarely observed";
}

function trendFromObsDates(data: any[]): string {
  const today = new Date();
  const daysAgo = (d: Date) =>
    Math.floor((today.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));

  let last15 = 0;
  let prev15 = 0;

  for (const o of data) {
    const dtStr: string | undefined = o.obsDt;
    if (!dtStr) continue;
    const d = new Date(dtStr.split(" ")[0] + "T00:00:00");
    const ago = daysAgo(d);
    if (ago < 0 || ago > 30) continue;
    if (ago <= 15) last15++;
    else prev15++;
  }

  if (prev15 <= 3) {
    if (last15 - prev15 >= 5) return "🆕 Emerging";
    return "➖ Stable";
  }

  if (last15 <= 3) {
    if (prev15 - last15 >= 5) return "🫥 Dropping off";
    return "➖ Stable";
  }

  const diff = last15 - prev15;
  const absDiff = Math.abs(diff);
  const relChange = absDiff / Math.max(prev15, 1);

  if (absDiff >= 3 && relChange >= 0.25) {
    return diff > 0 ? "📈 Increasing" : "📉 Decreasing";
  }

  return "➖ Stable";
}

/**
 * Recent public locations only (up to 5).
 * If none exist, returns a clear explanatory message.
 */
function formatRecentLocations(data: any[], limit = 5): string {
  const seenLocations = new Set<string>();
  const rows: string[] = [];

  const sorted = data
    .slice()
    .sort((a, b) => String(b.obsDt || "").localeCompare(String(a.obsDt || "")));

  for (const o of sorted) {
    if (o.locationPrivate === true) continue;

    const locId = o.locId;
    if (!locId || seenLocations.has(locId)) continue;

    seenLocations.add(locId);

    const date = o.obsDt ? String(o.obsDt).split(" ")[0] : "—";
    const place = o.locName ? String(o.locName) : "Unknown location";
    const subId = o.subId ? String(o.subId) : null;

    const link = subId ? `https://ebird.org/checklist/${subId}` : null;

    rows.push(
      link ? `• *${place}* — [${date}](${link})` : `• *${place}* — ${date}`,
    );

    if (rows.length >= limit) break;
  }

  if (rows.length === 0) {
    return "*No public locations reported in the last 30 days*";
  }

  return rows.join("\n");
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

    // Ensure taxonomy has finished loading (prevents 'data not ready' race)
    await this.taxonomy.ensureLoaded();


    const token = process.env.EBIRD_TOKEN;
    if (!token || !this.taxonomy.isLoaded()) {
      await interaction.reply({
        content: "❌ eBird data not ready. Try again shortly.",
        ephemeral: true,
      });
      return;
    }

    const entry = this.taxonomy.lookupCommonName(birdNameInput);
    if (!entry) {
      await interaction.reply({
        content: `❌ Could not find "${birdNameInput}" in eBird.`,
        ephemeral: true,
      });
      return;
    }

    const { speciesCode, comName } = entry;
    const obsUrl = `https://api.ebird.org/v2/data/obs/${county.code}/recent/${speciesCode}?back=30`;

    const res = await fetch(obsUrl, {
      headers: { "X-eBirdApiToken": token },
    });

    const data: any[] = res.ok ? await res.json() : [];
    const count = data.length;

    const lastReported =
      count > 0
        ? data.map((o) => o.obsDt).filter(Boolean).sort().reverse()[0]
        : "—";

    const embed = new EmbedBuilder()
      .setTitle(comName)
      .setDescription(county.label)
      .addFields(
        { name: "Observation frequency (30 days)", value: labelForCount(county.tier, count) },
        { name: "Number of reports (checklists)", value: String(count), inline: true },
        { name: "Last reported", value: String(lastReported), inline: true },
        { name: "Trend", value: trendFromObsDates(data), inline: true },
        { name: "Recent locations", value: formatRecentLocations(data, 5) },
        {
          name: "eBird",
          value: `[Region](https://ebird.org/region/${county.code}) • [Species](https://ebird.org/species/${speciesCode})`,
        },
      )
      .setFooter({
        text: "Source: eBird (last 30 days). Colors indicate observation frequency, not abundance.",
      });

    await interaction.reply({ embeds: [embed] });
  }
}
