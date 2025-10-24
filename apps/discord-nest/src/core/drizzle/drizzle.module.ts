import { Module } from '@nestjs/common';
import { DatabaseService } from './drizzle.service';

@Module({
  exports: [DatabaseService],
})
export class DatabaseModule {}
