import { Injectable } from "@nestjs/common";
import { EbirdTaxonomyService, type TaxonEntry } from "../ebird-taxonomy.service";
import { STANDARD_POOL } from "./standard.pool";

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
    if (e.category && e.category !== "species") return null;
    return e;
  }

  private extractAssetIdsFromHtml(html: string): string[] {
    const ids = new Set<string>();

    // Cornell CDN URLs
    {
      const re =
        /https:\/\/cdn\.download\.ams\.birds\.cornell\.edu\/api\/v1\/asset\/(\d{6,})(?:\/\d+)?/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) !== null) {
        if (m[1]) ids.add(m[1]);
      }
    }

    // ML######## in HTML
    {
      const re = /\bML(\d{6,})\b/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) !== null) {
        if (m[1]) ids.add(m[1]);
      }
    }

    // direct asset links
    {
      const re = /macaulaylibrary\.org\/asset\/(\d{6,})\b/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) !== null) {
        if (m[1]) ids.add(m[1]);
      }
    }

    return [...ids];
  }

  private async fetchCatalogPage(taxonCode: string, page: number): Promise<string> {
    const url = new URL("https://media.ebird.org/catalog");
    url.searchParams.set("taxonCode", taxonCode);
    url.searchParams.set("mediaType", "photo");
    url.searchParams.set("sort", "rating_rank_desc");
    url.searchParams.set("page", String(page));
    url.searchParams.set("birdOnly", "true");
    url.searchParams.set("view", "grid");

    const res = await fetch(url.toString(), {
      headers: {
        Accept: "text/html",
        "User-Agent": "Mozilla/5.0 (compatible; ScrubJayBot/1.0)",
      },
    });

    if (!res.ok) throw new Error(`eBird media catalog fetch failed: ${res.status}`);
    return res.text();
  }

  private async getRandomMacaulayPhotoFromEbirdCatalog(
    taxonCode: string,
  ): Promise<{ assetId: string; imageUrl: string }> {
    const MAX_PAGE_GUESS = 15;
    const ATTEMPTS = 10;

    for (let i = 0; i < ATTEMPTS; i++) {
      const page = 1 + Math.floor(Math.random() * MAX_PAGE_GUESS);
      const html = await this.fetchCatalogPage(taxonCode, page);
      const ids = this.extractAssetIdsFromHtml(html);
      if (ids.length === 0) continue;

      const assetId = pickRandom(ids);
      const imageUrl = `https://cdn.download.ams.birds.cornell.edu/api/v1/asset/${assetId}/900`;
      return { assetId, imageUrl };
    }

    // fallback page 1
    const html = await this.fetchCatalogPage(taxonCode, 1);
    const ids = this.extractAssetIdsFromHtml(html);
    if (ids.length > 0) {
      const assetId = pickRandom(ids);
      const imageUrl = `https://cdn.download.ams.birds.cornell.edu/api/v1/asset/${assetId}/900`;
      return { assetId, imageUrl };
    }

    throw new Error(`No Macaulay asset id found via media.ebird.org catalog (taxonCode=${taxonCode})`);
  }

  // request another random photo for a specific speciesCode
  public async getPhotoForSpeciesCode(
    speciesCode: string,
  ): Promise<{ assetId: string; imageUrl: string }> {
    await this.taxonomy.ensureLoaded();
    return this.getRandomMacaulayPhotoFromEbirdCatalog(speciesCode);
  }

  public async buildQuiz(
    pool: readonly string[] = STANDARD_POOL,
  ): Promise<{
    correctCode: string;
    correctName: string;
    choices: { code: string; name: string }[];
    imageUrl: string;
    assetId: string;
  }> {
    await this.taxonomy.ensureLoaded();

    let lastErr: unknown = null;

    for (let attempt = 0; attempt < 18; attempt++) {
      let correctEntry: TaxonEntry | null = null;

      for (let i = 0; i < 30 && !correctEntry; i++) {
        correctEntry = this.resolveCommonName(pickRandom(pool));
      }
      if (!correctEntry) {
        throw new Error("Could not resolve any pool common names to eBird species");
      }

      const correctCode = correctEntry.speciesCode;
      const correctName = correctEntry.comName;

      try {
        const { assetId, imageUrl } = await this.getRandomMacaulayPhotoFromEbirdCatalog(correctCode);

        const distractors: TaxonEntry[] = [];
        const seenCodes = new Set<string>([correctCode]);

        const candidates = shuffle(
          pool.filter(
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
            `Not enough valid distractors (need 3, got ${distractors.length}). Add more names to the selected pool.`,
          );
        }

        const choices = shuffle([correctEntry, ...distractors]).map((e) => ({
          code: e.speciesCode,
          name: e.comName,
        }));

        return { correctCode, correctName, choices, imageUrl, assetId };
      } catch (e) {
        lastErr = e;
        continue;
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error("Failed to build quiz (unknown error)");
  }
}
