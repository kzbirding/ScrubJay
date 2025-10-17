import { Module } from '@nestjs/common';
import { DatabaseService } from './database.service';

@Module({
  exports: [DatabaseService],
})
export class DatabaseModule {}
