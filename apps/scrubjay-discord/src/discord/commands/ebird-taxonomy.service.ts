import { Injectable, Logger, OnModuleInit } from "@nestjs/common";

export interface TaxonEntry {
  speciesCode: string;
  comName: string;
  sciName?: string;
}

@Injectable()
export class EbirdTaxonomyService implements OnModuleInit {
  private readonly logger = new Logger(EbirdTaxonomyService.name);

  // common name -> entry
  private byCommonName = new Map<string, TaxonEntry>();

  // speciesCode -> entry
  private bySpeciesCode = new Map<string, TaxonEntry>();

  async onModuleInit() {
    try {
      const token = process.env.EBIRD_TOKEN || process.env.EBIRD_TOKEN;
      if (!token) {
        this.logger.warn("No EBIRD_API_TOKEN set; taxonomy disabled");
        return;
      }

      const url = new URL("https://api.ebird.org/v2/ref/taxonomy/ebird");
      url.searchParams.set("fmt", "json");
      url.searchParams.set("locale", "en");

      const res = await fetch(url.toString(), {
        headers: {
          "X-eBirdApiToken": token,
        },
      });

      if (!res.ok) {
        throw new Error(`eBird taxonomy fetch failed: ${res.status} ${res.statusText}`);
      }

      const species = (await res.json()) as any[];

      this.byCommonName.clear();
      this.bySpeciesCode.clear();

      for (const r of species) {
        if (!r?.speciesCode || !r?.comName) continue;

        const entry: TaxonEntry = {
          speciesCode: String(r.speciesCode),
          comName: String(r.comName),
          sciName: r.sciName ? String(r.sciName) : undefined,
        };

        const key = entry.comName.toLowerCase().trim();
        if (!this.byCommonName.has(key)) {
          this.byCommonName.set(key, entry);
        }

        this.bySpeciesCode.set(entry.speciesCode, entry);
      }

      this.logger.log(`Loaded eBird taxonomy: ${this.byCommonName.size} species`);
    } catch (err: any) {
      this.logger.error(`Failed to load eBird taxonomy: ${err?.message ?? err}`, err?.stack);
    }
  }

  // Back-compat for your existing /status usage
  public isLoaded(): boolean {
    return this.byCommonName.size > 0;
  }

  // Back-compat alias for your existing /status usage
  public lookupCommonName(name: string): TaxonEntry | null {
    return this.lookupByCommonName(name);
  }

  public lookupByCommonName(name: string): TaxonEntry | null {
    if (!name) return null;
    const key = name.toLowerCase().trim();
    return this.byCommonName.get(key) ?? null;
  }

  public lookupBySpeciesCode(code: string): TaxonEntry | null {
    if (!code) return null;
    return this.bySpeciesCode.get(code) ?? null;
  }

private loadPromise: Promise<void> | null = null;

public async ensureLoaded(): Promise<void> {
  if (this.isLoaded()) return;
  if (!this.loadPromise) this.loadPromise = this.onModuleInit();
  await this.loadPromise;
}

}
