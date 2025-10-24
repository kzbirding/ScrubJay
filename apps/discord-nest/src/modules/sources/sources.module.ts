import { DatabaseModule } from "@/core/drizzle/drizzle.module";
import { SourcesService } from "./sources.service";
import { Module } from "@nestjs/common";

@Module({
  imports: [DatabaseModule],
  providers: [SourcesService],
  exports: [SourcesService],
})
export class SourcesModule {}