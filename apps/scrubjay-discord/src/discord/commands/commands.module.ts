import { Module } from "@nestjs/common";
import { FiltersModule } from "@/features/filters/filters.module";
import { SubscriptionsModule } from "@/features/subscriptions/subscriptions.module";

import { PhotoCommands } from "./photo-commands.service";
import { SubscriptionCommands } from "./subscription-commands.service";
import { UtilCommands } from "./util-commands.service";
import { StatusCommand } from "./status.command";
import { EbirdTaxonomyService } from "./ebird-taxonomy.service";

import { MeetupCommands } from "./meetup/meetup.commands";
import { MeetupBoardService } from "./meetup/meetup.board.service";

@Module({
  imports: [FiltersModule, SubscriptionsModule],
  providers: [
    UtilCommands,
    SubscriptionCommands,
    PhotoCommands,
    EbirdTaxonomyService,
    StatusCommand,

    MeetupCommands,
    MeetupBoardService,
  ],
})
export class CommandsModule {}
