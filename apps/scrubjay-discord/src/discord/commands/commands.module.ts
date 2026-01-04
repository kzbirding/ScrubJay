import { Module } from "@nestjs/common";
import { FiltersModule } from "@/features/filters/filters.module";
import { SubscriptionsModule } from "@/features/subscriptions/subscriptions.module";
import { PhotoCommands } from "./photo-commands.service";
import { SubscriptionCommands } from "./subscription-commands.service";
import { UtilCommands } from "./util-commands.service";
import { StatusCommand } from "./status.command";

@Module({
  imports: [FiltersModule, SubscriptionsModule],
  providers: [
    UtilCommands,
    SubscriptionCommands,
    PhotoCommands,
    StatusCommand, // 👈 AND THIS
  ],
})
export class CommandsModule {}
