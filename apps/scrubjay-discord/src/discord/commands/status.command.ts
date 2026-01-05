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
  // San Diego (HIGH)
  "san diego": { code: "US-CA-073", label: "San Diego County, CA", tier: "HIGH" },
  "san diego county": {
    code: "US-CA-073",
    label: "San Diego County, CA",
    tier: "HIGH",
  },

  // Imperial (LOW)
  imperial: { code: "US-CA-025", label: "Imperial County, CA", tier: "LOW" },
  "imperial county": {
    code: "US-CA-025",
    label: "Imperial County, CA",
    tier: "LOW",
  },

  // Orange (HIGH)
  orange: { code: "US-CA-059", label: "Orange County, CA", tier: "HIGH" },
  "orange county": {
    code: "US-CA-059",
    label: "Orange County, CA",
    tier: "HIGH",
  },
  oc: { code: "US-CA-059", label: "Orange County, CA", tier: "HIGH" },

  // Los Angeles (HIGH)
  "los angeles": {
    code: "US-CA-037",
    label: "Los Angeles County, CA",
    tier: "HIGH",
  },
  "los angeles county": {
    code: "US-CA-037",
    label: "Los Angeles County, CA",
    tier: "HIGH",
  },
  la: { code: "US-CA-037", label: "Los Angeles County, CA", tier: "HIGH" },

  // San Bernardino (MODERATE)
  "san bernardino": {
    code: "US-CA-071",
    label: "San Bernardino County, CA",
    tier: "MODERATE",
  },
  "san bernardino county": {
    code: "US-CA-071",
    label: "San Bernardino County, CA",
    tier: "MODERATE",
  },
  sb: {
    code: "US-CA-071",
    label: "San Bernardino County, CA",
    tier: "MODERATE",
  },

  // Riverside (MODERATE)
  riverside: {
    code: "US-CA-065",
    label: "Riverside County, CA",
    tier: "MODERATE",
  },
  "riverside county": {
    code: "US-CA-065",
    label: "Riverside County, CA",
    tier: "MODERATE",
  },
};

function normalizeRegion(input: string): string {
  return input.toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * Observation-frequency labels (NOT abundance).
 */
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

  // LOW (Imperial)
  if (count >= 60) return "🟢 Very frequently observed";
  if (count >= 20) return "🟢 Frequently observed";
  if (count >= 6) return "🟡 Regularly observed";
  if (count >= 2) return "🟠 Occasionally observed";
  return "🔴 Rarely observed";
}

/**
 * Trend is based on report volume:
 * - split last 30d into last 15d vs previous 15d
 * - avoid 0->1 being "increasing"
 * - still catch real arrivals/irruptions (near-zero -> many)
 */
function trendFromObsDates(data: any[]): string {
  const today = new Date();
  const daysAgo = (d: Date) =>
    Math.floor((today.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));

  let last15 = 0; // days 0-15
  let prev15 = 0; // days 16-30

  for (const o of data) {
    const dtStr: string | undefined = o.obsDt;
    if (!dtStr) continue;
    const d = new Date(dtStr.split(" ")[0] + "T00:00:00");
    const ago = daysAgo(d);
    if (ago < 0 || ago > 30) continue;
    if (ago <= 15) last15++;
    else prev15++;
  }

  const total = last15 + prev15;
  if (total === 0) return "—";

  // Emerging / Dropping off (handles small baseline without fake trends)
  // Previous was ~nothing, recent shows real activity.
  if (prev15 <= 3) {
    // If it jumped by 5+ from a near-zero baseline, call it emerging.
    if (last15 - prev15 >= 5) return "🆕 Emerging";
    return "➖ Stable";
  }

  // If it collapses to ~nothing recently, only flag if it dropped a lot.
  if (last15 <= 3) {
    if (prev15 - last15 >= 5) return "🫥 Dropping off";
    return "➖ Stable";
  }

  // Normal trend logic when both halves have signal
  const diff = last15 - prev15;
  const absDiff = Math.abs(diff);
  const relChange = absDiff / Math.max(prev15, 1);

  // Require both an absolute and relative change to avoid noise
  if (absDiff >= 3 && relChange >= 0.25) {
    return diff > 0 ? "📈 Increasing" : "📉 Decreasing";
  }

  return "➖ Stable";
}

/**
 * Compact: most recent N unique locations (dedupe by locId).
 * Uses checklist links (subId) so it always opens a valid eBird page.
 * Links inside embed fields do NOT unfurl.
 */
function formatRecentLocations(data: any[], limit = 3): string {
  const seenLocations = new Set<string>();
  const rows: string[] = [];

  const sorted = data
    .slice()
    .sort((a, b) => String(b.obsDt || "").localeCompare(String(a.obsDt || "")));

  for (const o of sorted) {
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

  return rows.length ? rows.join("\n") : "—";
}

/**
 * "Hottest hotspot" = location with the most reports in the 30d feed.
 * Uses the latest checklist at that location for a reliable link.
 * Hotspot link may not resolve for personal locations, but checklist link will.
 */
function formatTopLocation(data: any[]): string {
  if (!data.length) return "—";

  const map = new Map<
    string,
    { name: string; reports: number; latestObsDt: string; latestSubId?: string }
  >();

  for (const o of data) {
    const locId = o.locId ? String(o.locId) : "";
    if (!locId) continue;

    const name = o.locName ? String(o.locName) : "Unknown location";
    const obsDt = o.obsDt ? String(o.obsDt) : "";
    const subId = o.subId ? String(o.subId) : undefined;

    const prev = map.get(locId);
    if (!prev) {
      map.set(locId, {
        name,
        reports: 1,
        latestObsDt: obsDt,
        latestSubId: subId,
      });
    } else {
      prev.reports += 1;
      if (obsDt && obsDt.localeCompare(prev.latestObsDt) > 0) {
        prev.latestObsDt = obsDt;
        prev.latestSubId = subId;
      }
    }
  }

  if (map.size === 0) return "—";

  const [bestLocId, info] = Array.from(map.entries()).sort((a, b) => {
    if (b[1].reports !== a[1].reports) return b[1].reports - a[1].reports;
    return String(b[1].latestObsDt || "").localeCompare(String(a[1].latestObsDt || ""));
  })[0];

  const date = info.latestObsDt ? info.latestObsDt.split(" ")[0] : "—";
  const checklistLink = info.latestSubId
    ? `https://ebird.org/checklist/${info.latestSubId}`
    : null;

  const locLink = `https://ebird.org/hotspot/${bestLocId}`;

  const left = `*${info.name}* — **${info.reports}** reports`;
  const right = checklistLink
    ? `([latest](${checklistLink}) • [hotspot](${locLink}))`
    : `([hotspot](${locLink}))`;

  return `${left} ${right}\n*as of ${date}*`;
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
        {
          name: "Observation frequency (30 days)",
          value: labelForCount(county.tier, count),
          inline: false,
        },
        { name: "Recent reports", value: String(count), inline: true },
        { name: "Last reported", value: String(lastReported), inline: true },
        { name: "Trend", value: trendFromObsDates(data), inline: true },

        // 3 most recent unique locations
        { name: "Recent locations", value: formatRecentLocations(data, 3), inline: false },

        // 1 hottest location/hotspot (by report count)
        { name: "Hottest hotspot (30d)", value: formatTopLocation(data), inline: false },

        // Keep only the links that are known-good
        {
          name: "eBird",
          value: `[Region](https://ebird.org/region/${county.code}) • [Species](https://ebird.org/species/${speciesCode})`,
          inline: false,
        },
      )
      .setFooter({
        text: "Source: eBird (last 30 days). Colors indicate observation frequency, not abundance.",
      });

    await interaction.reply({ embeds: [embed] });
  }
}
