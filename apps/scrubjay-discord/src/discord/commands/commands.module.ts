import { Module } from "@nestjs/common";
import { HttpModule } from "@nestjs/axios";

import { FiltersModule } from "@/features/filters/filters.module";
import { SubscriptionsModule } from "@/features/subscriptions/subscriptions.module";

import { PhotoCommands } from "./photo-commands.service";
import { SubscriptionCommands } from "./subscription-commands.service";
import { UtilCommands } from "./util-commands.service";
import { StatusCommand } from "./status.command";
import { EbirdTaxonomyService } from "./ebird-taxonomy.service";
import { BigdayCommand } from "./bigday.command";

import { MeetupCommands } from "./meetup/meetup.commands";
import { MeetupBoardService } from "./meetup/meetup.board.service";

// ✅ NEW: Quiz
import { QCommand } from "./q/q.command";
import { QuizService } from "./q/q.service";
import { QACommand } from "./q/q.command";

@Module({
  imports: [
    FiltersModule,
    SubscriptionsModule,
    HttpModule, // ✅ needed for HttpService used in EbirdTaxonomyService
  ],
  providers: [
    UtilCommands,
    SubscriptionCommands,
    PhotoCommands,
    EbirdTaxonomyService,
    StatusCommand,
    BigdayCommand,
    QACommand,
    MeetupCommands,
    MeetupBoardService,

    // ✅ NEW: Quiz
    QuizService,
    QCommand,
  ],
})
export class CommandsModule {}
