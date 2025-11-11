import { EBirdDispatchService } from "@/modules/dispatch/ebird/ebird.dispatch";
import { Cron } from "@nestjs/schedule";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { EBirdIngestionService } from "@/modules/ingestion/ebird/ebird.ingestion";
import { SourcesService } from "@/modules/sources/sources.service";

@Injectable()
export class EBirdWorkflow implements OnModuleInit {
  private readonly logger = new Logger(EBirdWorkflow.name);
  private lastRun: Date | null = null;

  constructor(
    private readonly ebirdDispatchService: EBirdDispatchService,
    private readonly ebirdIngestionService: EBirdIngestionService,
    private readonly sourcesService: SourcesService,
  ) {}

  onModuleInit() {
    this.lastRun = new Date();
    this.runWorkflow();
  }

  @Cron('*/1 * * * *')
  async runWorkflow(shouldSendNotifications: boolean = true) {
   
    try {
      this.logger.log('Running eBird workflow');

      const sources = await this.sourcesService.getActiveSourcesByType('EBIRD');
      if (!sources || sources.length === 0) {
        this.logger.error('No active eBird sources found');
        return;
      }

      this.logger.log(`Found ${sources.length} active eBird sources`);

      await Promise.allSettled(sources.map(async (source) => {
        try {
          await this.ebirdIngestionService.ingest(source);
          this.logger.log(`Successfully ingested source ${source.id}`);
        } catch (error) {
          this.logger.error(`Error ingesting source ${source.id}: ${error}`);
        }
      }));

      try {
        const dispatchedCount = await this.ebirdDispatchService.dispatch();
        this.logger.log(`Successfully dispatched ${dispatchedCount} eBird observations`);
      } catch (error) {
        this.logger.error(`Error dispatching eBird data: ${error}`);
      }
    } catch (error) {
      this.logger.error(`Error running eBird workflow: ${error}`);
      throw new Error(`Error running eBird workflow: ${error}`);
    }
  }
}