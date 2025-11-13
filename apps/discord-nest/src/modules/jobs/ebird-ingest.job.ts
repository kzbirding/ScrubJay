import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { EBirdService } from "../ebird/ebird.service";
import { BootstrapService } from "./bootstrap.service";

@Injectable()
export class EBirdIngestJob {
  private readonly logger = new Logger(EBirdIngestJob.name);

  private readonly states = ["US-NC", "US-CA"];

  constructor(
    private readonly ebird: EBirdService,
    private readonly bootstrapService: BootstrapService
  ) {}

  @Cron("*/15 * * * * *")
  async run() {
    // Wait for bootstrap to complete before running
    await this.bootstrapService.waitForBootstrap();

    this.logger.debug("Starting eBird ingestion job...");

    let total = 0;
    for (const state of this.states) {
      try {
        const inserted = await this.ebird.ingestRegion(state);
        total += inserted;
        this.logger.log(`State ${state}: ${inserted} alerts ingested`);
      } catch (err) {
        this.logger.error(`Failed to ingest ${state}: ${err}`);
      }
    }
  }
}
