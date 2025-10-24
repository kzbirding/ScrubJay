import { Module } from '@nestjs/common';
import { DatabaseModule } from '@/core/drizzle/drizzle.module';
import { EBirdDispatchService } from './ebird/ebird.dispatch';
import { DiscordModule } from '../../core/discord/discord.module';

@Module({
  imports: [DatabaseModule, DiscordModule],
  providers: [EBirdDispatchService],
  exports: [EBirdDispatchService],
})
export class DispatchModule {}
