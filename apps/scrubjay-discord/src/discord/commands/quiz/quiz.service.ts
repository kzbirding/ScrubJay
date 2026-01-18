import { Injectable } from "@nestjs/common";
import { EbirdTaxonomyService, type TaxonEntry } from "../ebird-taxonomy.service";
import { SOCAL_COMMON_NAMES } from "./socal.names";

function pickRandom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
function shuffle<T>(arr: readonly T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

@Injectable()
export class QuizService {
  constructor(private readonly taxonomy: EbirdTaxonomyService) {}

  private resolveCommonName(name: string): TaxonEntry | null {
    const e = this.taxonomy.lookupByCommonNameFuzzy(name);
    if (!e) return null;

    // keep quiz clean: only real species
    if (e.category && e.category !== "species") return null;

    return e;
  }

  private extractAssetId(html: string): string | null {
    // Macaulay assets can show up as:
    // - /asset/46340351
    // - ML46340351
    // - "assetId":46340351
    // - assetId=ML46340351
    const patterns: RegExp[] = [
      /\/asset\/(\d{6,})\b/i,
      /\bML(\d{6,})\b/i,
      /"assetId"\s*:\s*"?(\d{6,})"?/i,
      /assetId=ML(\d{6,})/i,
      /assetId=(\d{6,})/i,
    ];

    for (const re of patterns) {
      const m = html.match(re);
      if (m?.[1]) return m[1];
    }
    return null;
  }

  private async getMacaulayImageUrl(
    taxonCode: string,
  ): Promise<{ assetId: string; imageUrl: string }> {
    const urls = [
      `https://search.macaulaylibrary.org/catalog?taxonCode=${encodeURIComponent(
        taxonCode,
      )}&mediaType=photo&sort=rating_rank_desc&view=list`,
      `https://media.ebird.org/catalog?taxonCode=${encodeURIComponent(
        taxonCode,
      )}&mediaType=photo&sort=rating_rank_desc&view=list`,
    ];

    let lastStatus: number | null = null;

    for (const url of urls) {
      const res = await fetch(url, {
        headers: {
          Accept: "text/html",
          // helps some CDNs treat this like a normal browser request
          "User-Agent": "Mozilla/5.0 (compatible; ScrubJayBot/1.0)",
        },
      });

      lastStatus = res.status;

      if (!res.ok) continue;

      const html = await res.text();
      const assetId = this.extractAssetId(html);
      if (!assetId) continue;

      // Cornell CDN image endpoint (works with numeric assetId)
      const imageUrl = `https://cdn.download.ams.birds.cornell.edu/api/v1/asset/${assetId}/900`;
      return { assetId, imageUrl };
    }

    throw new Error(
      `No Macaulay asset id found (taxonCode=${taxonCode}, lastStatus=${lastStatus ?? "n/a"})`,
    );
  }

  public async buildQuiz(): Promise<{
    correctCode: string; // speciesCode
    correctName: string; // common name
    choices: { code: string; name: string }[]; // code = speciesCode, name = common name
    imageUrl: string;
    assetId: string;
  }> {
    await this.taxonomy.ensureLoaded();

    // We may need to try multiple birds until we find one whose Macaulay HTML yields an asset id.
    let lastErr: unknown = null;

    for (let attempt = 0; attempt < 12; attempt++) {
      // 1) pick a correct bird from your common-name list
      let correctEntry: TaxonEntry | null = null;
      for (let i = 0; i < 25 && !correctEntry; i++) {
        const candidateName = pickRandom(SOCAL_COMMON_NAMES);
        correctEntry = this.resolveCommonName(candidateName);
      }
      if (!correctEntry) {
        throw new Error(
          "Could not resolve any SoCal common names to eBird species (check SOCAL_COMMON_NAMES)",
        );
      }

      const correctCode = correctEntry.speciesCode;
      const correctName = correctEntry.comName;

      try {
        // 2) fetch Macaulay photo
        const { assetId, imageUrl } = await this.getMacaulayImageUrl(correctCode);

        // 3) build distractors
        const distractors: TaxonEntry[] = [];
        const seenCodes = new Set<string>([correctCode]);

        const candidates = shuffle(
          SOCAL_COMMON_NAMES.filter(
            (n) => n.toLowerCase().trim() !== correctName.toLowerCase().trim(),
          ),
        );

        for (const name of candidates) {
          const e = this.resolveCommonName(name);
          if (!e) continue;
          if (seenCodes.has(e.speciesCode)) continue;

          seenCodes.add(e.speciesCode);
          distractors.push(e);
          if (distractors.length >= 3) break;
        }

        if (distractors.length < 3) {
          throw new Error(
            `Not enough valid distractors (need 3, got ${distractors.length}). Add more names to SOCAL_COMMON_NAMES.`,
          );
        }

        const choiceEntries = shuffle([correctEntry, ...distractors]);
        const choices = choiceEntries.map((e) => ({ code: e.speciesCode, name: e.comName }));

        return {
          correctCode,
          correctName,
          choices,
          imageUrl,
          assetId,
        };
      } catch (e) {
        // Try a different bird instead of crashing the whole command
        lastErr = e;
        continue;
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error("Failed to build quiz (unknown error)");
  }
}
