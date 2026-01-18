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

  private extractAssetIdsFromHtml(html: string): string[] {
    // media.ebird.org catalog pages include real photo URLs like:
    // https://cdn.download.ams.birds.cornell.edu/api/v1/asset/320005481/1800
    // We extract all numeric asset IDs.
    const ids: string[] = [];
    const re = /https:\/\/cdn\.download\.ams\.birds\.cornell\.edu\/api\/v1\/asset\/(\d{6,})(?:\/\d+)?/gi;

    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      if (m[1]) ids.push(m[1]);
    }

    // Deduplicate
    return [...new Set(ids)];
  }

  private async fetchCatalogPage(taxonCode: string, page: number): Promise<string> {
    const url = new URL("https://media.ebird.org/catalog");
    url.searchParams.set("taxonCode", taxonCode);
    url.searchParams.set("mediaType", "photo");
    // Sorting helps avoid empty/weird pages for some taxa
    url.searchParams.set("sort", "rating_rank_desc");
    url.searchParams.set("page", String(page));

    const res = await fetch(url.toString(), {
      headers: {
        Accept: "text/html",
        "User-Agent": "Mozilla/5.0 (compatible; ScrubJayBot/1.0)",
      },
    });

    if (!res.ok) {
      throw new Error(`eBird media catalog fetch failed: ${res.status}`);
    }

    return res.text();
  }

  private async getRandomMacaulayPhotoFromEbirdCatalog(
    taxonCode: string,
  ): Promise<{ assetId: string; imageUrl: string }> {
    // We don’t have an official “total pages” API here, so we do a practical approach:
    // - try a handful of random pages in a reasonable range
    // - extract all real photo asset IDs from the HTML
    // - pick one at random
    //
    // This yields good randomness without scraping the Macaulay JS search app.

    const MAX_PAGE_GUESS = 12; // increase later if you want more variety
    const ATTEMPTS = 8;

    let lastErr: unknown = null;

    for (let i = 0; i < ATTEMPTS; i++) {
      // Random page 1..MAX_PAGE_GUESS
      const page = 1 + Math.floor(Math.random() * MAX_PAGE_GUESS);

      try {
        const html = await this.fetchCatalogPage(taxonCode, page);
        const ids = this.extractAssetIdsFromHtml(html);

        if (ids.length === 0) {
          // try another page
          continue;
        }

        const assetId = pickRandom(ids);

        // Discord-friendly size
        const imageUrl = `https://cdn.download.ams.birds.cornell.edu/api/v1/asset/${assetId}/900`;
        return { assetId, imageUrl };
      } catch (e) {
        lastErr = e;
        continue;
      }
    }

    // As a last-ditch fallback, try page 1 once (usually has something)
    try {
      const html = await this.fetchCatalogPage(taxonCode, 1);
      const ids = this.extractAssetIdsFromHtml(html);
      if (ids.length > 0) {
        const assetId = pickRandom(ids);
        const imageUrl = `https://cdn.download.ams.birds.cornell.edu/api/v1/asset/${assetId}/900`;
        return { assetId, imageUrl };
      }
    } catch (e) {
      lastErr = e;
    }

    throw lastErr instanceof Error
      ? lastErr
      : new Error(`No Macaulay asset id found via media.ebird.org catalog (taxonCode=${taxonCode})`);
  }

  public async buildQuiz(): Promise<{
    correctCode: string; // speciesCode
    correctName: string; // common name
    choices: { code: string; name: string }[]; // code = speciesCode, name = common name
    imageUrl: string;
    assetId: string;
  }> {
    await this.taxonomy.ensureLoaded();

    // We may need to try multiple birds until we find one that yields photos
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
        // 2) fetch a random photo from eBird media catalog (Macaulay-backed)
        const { assetId, imageUrl } = await this.getRandomMacaulayPhotoFromEbirdCatalog(correctCode);

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
        lastErr = e;
        continue;
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error("Failed to build quiz (unknown error)");
  }
}
