import { Injectable, Logger } from "@nestjs/common";
import { EmbedBuilder } from "discord.js";
import { Context, Options, SlashCommand, type SlashCommandContext } from "necord";
import { PhotoCommandDto } from "./commands.dto";

type INatTaxon = {
  id: number;
  name: string;
  preferred_common_name?: string;
  taxon_photos?: Array<{
    photo: {
      url: string;
      license_code?: string;
      attribution?: string;
    };
  }>;
};

type INatPhotoPick = {
  imageUrl: string;
  attribution: string;
  license: string;
  obsUrl: string;
};

@Injectable()
export class PhotoCommands {
  private readonly logger = new Logger(PhotoCommands.name);

  @SlashCommand({
    description: "Fetch bird photos (via iNaturalist)",
    name: "photo",
  })
  public async onPhoto(
    @Context() [interaction]: SlashCommandContext,
    @Options() options: PhotoCommandDto,
  ) {
    const query = (options.query || "").trim();
    const count = Math.max(1, Math.min(options.count ?? 2, 4));

    if (!query) {
      return interaction.reply({ content: "Please provide a bird name." });
    }

    await interaction.deferReply();

    try {
      const taxon = await this.findBirdTaxon(query);
      if (!taxon) {
        return interaction.editReply(
          `Couldn't find a bird species for **${query}**.`,
        );
      }

      // Prefer curated "taxon photos" (usually much better than random observations)
      let photos = this.getTaxonPhotos(taxon, count);

      // Fallback: if a taxon has no curated photos, fall back to recent research-grade observations
      if (!photos.length) {
        photos = await this.getRecentPhotos(taxon.id, count);
      }

      if (!photos.length) {
        const label = taxon.preferred_common_name
          ? `${taxon.preferred_common_name} (${taxon.name})`
          : taxon.name;

        return interaction.editReply(
          `Found **${label}**, but couldn't find photos right now.`,
        );
      }

      const title = taxon.preferred_common_name
        ? `${taxon.preferred_common_name} (${taxon.name})`
        : taxon.name;

      const embeds = photos.map((p, idx) =>
        new EmbedBuilder()
          .setTitle(title)
          .setURL(p.obsUrl)
          .setDescription(
            `Photo ${idx + 1}/${photos.length}\n**Credit:** ${p.attribution}\n**License:** ${p.license.toUpperCase()}`,
          )
          .setImage(p.imageUrl)
          .setFooter({ text: "Source: iNaturalist" }),
      );

      return interaction.editReply({ embeds });
    } catch (err) {
      this.logger.error(`Photo command failed: ${err}`);
      return interaction.editReply(
        `Something went wrong fetching photos for **${query}**. Try a more specific name.`,
      );
    }
  }

  private async findBirdTaxon(query: string): Promise<INatTaxon | null> {
    const url = new URL("https://api.inaturalist.org/v1/taxa");
    url.searchParams.set("q", query);
    url.searchParams.set("rank", "species");
    url.searchParams.set("per_page", "5");
    // Birds (Aves) = taxon_id 3 on iNaturalist
    url.searchParams.set("taxon_id", "3");

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`iNat taxa search failed: ${res.status}`);
    const data = (await res.json()) as { results: INatTaxon[] };

    const q = query.toLowerCase();
    const best =
      data.results.find(
        (t) => (t.preferred_common_name || "").toLowerCase() === q,
      ) ?? data.results[0];

    return best ?? null;
  }

  private getTaxonPhotos(taxon: INatTaxon, count: number): INatPhotoPick[] {
    const picks: INatPhotoPick[] = [];
    const tp = taxon.taxon_photos || [];

    for (const item of tp) {
      const p = item?.photo;
      if (!p?.url) continue;

      // iNat often gives square/small urls; swap to large for Discord embeds
      const imageUrl = String(p.url)
        .replace("square", "large")
        .replace("small", "large");

      picks.push({
        imageUrl,
        attribution: p.attribution || "unknown",
        license: p.license_code || "unknown",
        // Link to the species page when using curated photos
        obsUrl: `https://www.inaturalist.org/taxa/${taxon.id}`,
      });

      if (picks.length >= count) break;
    }

    return picks;
  }

  private async getRecentPhotos(
    taxonId: number,
    count: number,
  ): Promise<INatPhotoPick[]> {
    const url = new URL("https://api.inaturalist.org/v1/observations");
    url.searchParams.set("taxon_id", String(taxonId));
    url.searchParams.set("quality_grade", "research");
    url.searchParams.set("photos", "true");
    url.searchParams.set("per_page", "25");
    url.searchParams.set("order", "desc");
    url.searchParams.set("order_by", "created_at");

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`iNat observations failed: ${res.status}`);
    const data = (await res.json()) as any;

    const picks: INatPhotoPick[] = [];
    for (const obs of data.results || []) {
      for (const p of obs.photos || []) {
        if (!p?.url) continue;

        const imageUrl = String(p.url)
          .replace("square", "large")
          .replace("small", "large");

        picks.push({
          imageUrl,
          attribution: p.attribution || obs.user?.login || "unknown",
          license: p.license_code || obs.license_code || "unknown",
          obsUrl: obs.uri || `https://www.inaturalist.org/observations/${obs.id}`,
        });

        if (picks.length >= count) return picks;
      }
    }

    return picks;
  }
}
