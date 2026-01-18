import { Injectable } from "@nestjs/common";
import { EbirdTaxonomyService } from "../../services/ebird-taxonomy.service"; // adjust path if yours differs
import { SOCAL_TAXON_CODES } from "./socal.taxons";

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
function shuffle<T>(arr: T[]): T[] {
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

  private async getMacaulayImageUrl(taxonCode: string): Promise<{ assetId: string; imageUrl: string }> {
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

  public async buildQuiz(): Promise<{
    correctCode: string;
    correctName: string;
    choices: { code: string; name: string }[];
    imageUrl: string;
    assetId: string;
  }> {
    await this.taxonomy.ensureLoaded();

    // pick a random code that has a taxonomy entry
    let correctCode = pickRandom(SOCAL_TAXON_CODES);
    let correctEntry = this.taxonomy.lookupBySpeciesCode(correctCode);

    // try a few times if taxonomy not loaded or code missing
    for (let i = 0; i < 10 && !correctEntry; i++) {
      correctCode = pickRandom(SOCAL_TAXON_CODES);
      correctEntry = this.taxonomy.lookupBySpeciesCode(correctCode);
    }
    if (!correctEntry) throw new Error("Taxonomy not ready or SoCal list has unknown codes");

    const { assetId, imageUrl } = await this.getMacaulayImageUrl(correctCode);

    const distractorCodes = shuffle(
      SOCAL_TAXON_CODES.filter((c) => c !== correctCode),
    ).slice(0, 3);

    const choiceCodes = shuffle([correctCode, ...distractorCodes]);

    const choices = choiceCodes.map((code) => {
      const e = this.taxonomy.lookupBySpeciesCode(code);
      return { code, name: e?.comName ?? code };
    });

    return {
      correctCode,
      correctName: correctEntry.comName,
      choices,
      imageUrl,
      assetId,
    };
  }
}
