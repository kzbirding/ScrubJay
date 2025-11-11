import { Module } from '@nestjs/common';
import { DrizzleModule } from '@/core/drizzle/drizzle.module';
import { DiscordModule } from '@/modules/discord/discord.module';
import { EBirdDispatchService } from './ebird/ebird.dispatch';

@Module({
  imports: [DrizzleModule, DiscordModule],
  providers: [EBirdDispatchService],
  exports: [EBirdDispatchService],
})
export class DispatchModule {}
