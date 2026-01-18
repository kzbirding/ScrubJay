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
import { QuizCommand } from "./quiz/quiz.command";
import { QuizService } from "./quiz/quiz.service";

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

    MeetupCommands,
    MeetupBoardService,

    // ✅ NEW: Quiz
    QuizService,
    QuizCommand,
  ],
})
export class CommandsModule {}
