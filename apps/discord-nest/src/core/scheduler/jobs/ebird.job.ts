import { EBirdIngestionService } from "@/modules/ingestion/ebird/ebird.service";
import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";

@Injectable()
export class EBirdJob {
  private readonly logger = new Logger(EBirdJob.name);
  constructor(private readonly ebirdIngestionService: EBirdIngestionService) {}

  // @Cron(CronExpression.EVERY_20_MINUTES)
  // async ingestObservations() {
  //     await this.ebirdIngestionService.ingestObservations();
  // }
}
