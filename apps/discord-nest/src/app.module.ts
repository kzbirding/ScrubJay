import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import * as Joi from "joi";

const configSchema = Joi.object({
  DISCORD_TOKEN: Joi.string().required(),
  DISCORD_CLIENT_ID: Joi.string().required(),
  EBIRD_TOKEN: Joi.string().required(),
  EBIRD_BASE_URL: Joi.string().optional().default("https://api.ebird.org/"),
});

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: configSchema,
    }),
  ],
  providers: [],
})
export class AppModule {}
