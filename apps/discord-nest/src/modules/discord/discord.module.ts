import { Module } from '@nestjs/common';
import { DiscordHelper } from './discord.helper';

@Module({
  providers: [DiscordHelper],
  exports: [DiscordHelper],
})
export class DiscordModule {}
