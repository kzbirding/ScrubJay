import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { HttpService } from "@nestjs/axios";
import { firstValueFrom } from "rxjs";

export interface TaxonEntry {
  speciesCode: string;
  comName: string;
  sciName?: string;
}

@Injectable()
export class EbirdTaxonomyService implements OnModuleInit {
  private readonly logger = new Logger(EbirdTaxonomyService.name);

  // existing map: common name -> entry
  private byCommonName = new Map<string, TaxonEntry>();

  // NEW: speciesCode -> entry
  private bySpeciesCode = new Map<string, TaxonEntry>();

  constructor(private readonly http: HttpService) {}

  async onModuleInit() {
    try {
      const token =
        process.env.EBIRD_API_TOKEN ||
        process.env.EBIRD_API_KEY;

      if (!token) {
        this.logger.warn("No EBIRD_API_TOKEN set; taxonomy disabled");
        return;
      }

      const res = await firstValueFrom(
        this.http.get("https://api.ebird.org/v2/ref/taxonomy/ebird", {
          headers: { "X-eBirdApiToken": token },
          params: {
            fmt: "json",
            locale: "en",
          },
        }),
      );

      const species = res.data as any[];

      this.byCommonName.clear();
      this.bySpeciesCode.clear();

      for (const r of species) {
        if (!r.speciesCode || !r.comName) continue;

        const entry: TaxonEntry = {
          speciesCode: r.speciesCode,
          comName: r.comName,
          sciName: r.sciName,
        };

        // normalize common name key
        const key = r.comName.toLowerCase().trim();

        if (!this.byCommonName.has(key)) {
          this.byCommonName.set(key, entry);
        }

        // NEW: reverse lookup
        this.bySpeciesCode.set(entry.speciesCode, entry);
      }

      this.logger.log(
        `Loaded eBird taxonomy: ${this.byCommonName.size} species`,
      );
    } catch (err) {
      this.logger.error("Failed to load eBird taxonomy", err);
    }
  }

  // EXISTING behavior (unchanged)
  public lookupByCommonName(name: string): TaxonEntry | null {
    if (!name) return null;
    const key = name.toLowerCase().trim();
    return this.byCommonName.get(key) ?? null;
  }

  // NEW method (additive, safe)
  public lookupBySpeciesCode(code: string): TaxonEntry | null {
    if (!code) return null;
    return this.bySpeciesCode.get(code) ?? null;
  }

  // Backwards-compatible: status.command.ts expects this
public isLoaded(): boolean {
  return this.byCommonName.size > 0;
}

// Backwards-compatible alias: status.command.ts calls lookupCommonName()
public lookupCommonName(name: string): TaxonEntry | null {
  return this.lookupByCommonName(name);
}

}
