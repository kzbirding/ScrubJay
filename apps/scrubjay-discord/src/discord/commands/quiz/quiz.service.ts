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

  private async getMacaulayImageUrl(
    taxonCode: string,
  ): Promise<{ assetId: string; imageUrl: string }> {
    // simple, cheap, no image downloading — just hotlink a Cornell CDN URL
    const url = `https://search.macaulaylibrary.org/catalog?taxonCode=${encodeURIComponent(
      taxonCode,
    )}&mediaType=photo`;

    const res = await fetch(url, { headers: { Accept: "text/html" } });
    if (!res.ok) throw new Error(`Macaulay fetch failed: ${res.status}`);

    const html = await res.text();

    // find first ML###### in the HTML
    const m = html.match(/\bML(\d{6,})\b/);
    if (!m) throw new Error("No Macaulay ML asset id found");

    const assetId = m[1];
    const imageUrl = `https://cdn.download.ams.birds.cornell.edu/api/v1/asset/${assetId}/900`;
    return { assetId, imageUrl };
  }

  private resolveCommonName(name: string): TaxonEntry | null {
    const e = this.taxonomy.lookupByCommonNameFuzzy(name);
    if (!e) return null;

    // optional safety: only allow real species
    if (e.category && e.category !== "species") return null;

    return e;
  }

  public async buildQuiz(): Promise<{
    correctCode: string; // speciesCode
    correctName: string; // common name
    choices: { code: string; name: string }[]; // code = speciesCode, name = common name
    imageUrl: string;
    assetId: string;
  }> {
    await this.taxonomy.ensureLoaded();

    // 1) Pick a correct bird from your common-name list, then resolve to taxonomy entry
    let correctEntry: TaxonEntry | null = null;
    for (let i = 0; i < 25 && !correctEntry; i++) {
      const candidateName = pickRandom(SOCAL_COMMON_NAMES);
      correctEntry = this.resolveCommonName(candidateName);
    }
    if (!correctEntry) {
      throw new Error("Could not resolve any SoCal common names to eBird species (check SOCAL_COMMON_NAMES)");
    }

    const correctCode = correctEntry.speciesCode;
    const correctName = correctEntry.comName;

    // 2) Fetch a Macaulay photo using the species code
    const { assetId, imageUrl } = await this.getMacaulayImageUrl(correctCode);

    // 3) Build distractors: resolve other names -> species entries, keep unique speciesCode
    const distractors: TaxonEntry[] = [];
    const seenCodes = new Set<string>([correctCode]);

    const candidates = shuffle(
      SOCAL_COMMON_NAMES.filter((n) => n.toLowerCase().trim() !== correctName.toLowerCase().trim()),
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

    // 4) Assemble and shuffle answer choices
    const choiceEntries = shuffle([correctEntry, ...distractors]);
    const choices = choiceEntries.map((e) => ({ code: e.speciesCode, name: e.comName }));

    return {
      correctCode,
      correctName,
      choices,
      imageUrl,
      assetId,
    };
  }
}
