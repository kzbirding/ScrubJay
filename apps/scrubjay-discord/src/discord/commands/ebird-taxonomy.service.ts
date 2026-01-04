import { Injectable, Logger, OnModuleInit } from "@nestjs/common";

type TaxonRow = {
  speciesCode?: string;
  comName?: string;
  sciName?: string;
  category?: string; // "species", "issf", etc
};

export type TaxonEntry = {
  speciesCode: string;
  comName: string;
  sciName?: string;
};

@Injectable()
export class EbirdTaxonomyService implements OnModuleInit {
  private readonly logger = new Logger(EbirdTaxonomyService.name);

  private loaded = false;
  private loadError: string | null = null;

  // normalized common name -> entry
  private byCommonName = new Map<string, TaxonEntry>();

  // helpful for suggestions
  private allCommonNames: string[] = [];

  private normalize(s: string): string {
    return s
      .toLowerCase()
      .trim()
      // remove most punctuation
      .replace(/[’'".,()/\-]/g, " ")
      .replace(/\s+/g, " ");
  }

  public isLoaded() {
    return this.loaded;
  }

  public getLoadError() {
    return this.loadError;
  }

  async onModuleInit() {
    const token = process.env.EBIRD_TOKEN; // <-- matches your Railway variable
    if (!token) {
      this.loadError = "ebird_token env var missing";
      this.logger.error(
        "Taxonomy not loaded: ebird_token is not set (Railway Variables).",
      );
      return;
    }

    const url = "https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json&locale=en";

    try {
      this.logger.log("Loading eBird taxonomy (one-time at startup)...");
      const res = await fetch(url, {
        headers: { "X-eBirdApiToken": token },
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        this.loadError = `HTTP ${res.status} ${body}`.slice(0, 500);
        this.logger.error(`Taxonomy load failed: ${this.loadError}`);
        return;
      }

      const rows = (await res.json()) as TaxonRow[];

      // Only keep true species
      const species = rows.filter(
        (r) =>
          r.category === "species" && !!r.speciesCode && !!r.comName,
      );

      this.byCommonName.clear();

      for (const r of species) {
        const key = this.normalize(r.comName!);
        // If duplicates exist, keep the first
        if (!this.byCommonName.has(key)) {
          this.byCommonName.set(key, {
            speciesCode: r.speciesCode!,
            comName: r.comName!,
            sciName: r.sciName,
          });
        }
      }

      this.allCommonNames = Array.from(this.byCommonName.values()).map(
        (e) => e.comName,
      );

      this.loaded = true;
      this.loadError = null;

      this.logger.log(
        `eBird taxonomy loaded: ${this.byCommonName.size} species`,
      );
    } catch (err: any) {
      this.loadError = (err?.message ?? String(err)).slice(0, 500);
      this.logger.error(`Taxonomy load threw: ${this.loadError}`);
    }
  }

  public lookupCommonName(name: string): TaxonEntry | null {
    const key = this.normalize(name);
    return this.byCommonName.get(key) ?? null;
  }

  public suggest(name: string, limit = 5): string[] {
    const q = this.normalize(name);
    if (!q) return [];

    // simple contains-based suggestion
    const out: string[] = [];
    for (const entry of this.byCommonName.values()) {
      const norm = this.normalize(entry.comName);
      if (norm.includes(q)) out.push(entry.comName);
      if (out.length >= limit) break;
    }
    return out;
  }
}
