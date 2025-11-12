import { Module } from "@nestjs/common";
import { DispatcherRepository } from "./dispatcher.repository";
import { DispatcherService } from "./dispatcher.service";
import { DrizzleModule } from "@/core/drizzle/drizzle.module";
import { DeliveriesModule } from "../deliveries/deliveries.module";

@Module({
  imports: [DrizzleModule, DeliveriesModule],
  providers: [DispatcherRepository, DispatcherService],
  exports: [DispatcherService],
})
export class DispatcherModule {}
