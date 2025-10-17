import { Injectable, Logger } from "@nestjs/common";
import { EBirdService } from "./ebird/ebird.service";
import { SourcesService } from "../sources/sources.service";
import { SourceType } from "../sources/sources.schema";

@Injectable()
export class IngestionFacade {
  private readonly logger = new Logger(IngestionFacade.name);

  constructor(
    private readonly ebird: EBirdService,
    private readonly sources: SourcesService
  ) {}

  async handleType(type: SourceType): Promise<{ totalPosted: number }> {
    const sourcesList = await this.sources.findActiveByType(type);
    
    if (sourcesList.length === 0) {
      this.logger.log(`No active sources found for type: ${type}`);
      return { totalPosted: 0 };
    }

    this.logger.log(`Processing ${sourcesList.length} active sources of type: ${type}`);

    switch (type) {
        case 'EBIRD':
            return this.ebird.ingest(sourcesList);
        default:
            throw new Error(`Unsupported source type: ${type}`);
    }
  }
}
