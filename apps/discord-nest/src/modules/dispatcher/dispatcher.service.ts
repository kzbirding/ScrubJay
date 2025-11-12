import { Injectable, Logger } from "@nestjs/common";
import { DispatcherRepository } from "./dispatcher.repository";
import { DrizzleService } from "@/core/drizzle/drizzle.service";
import { gt } from "drizzle-orm";
import { observations } from "@/core/drizzle/drizzle.schema";
import { TransformedEBirdObservation } from "../ebird/ebird.schema";
import { DeliveriesService } from "../deliveries/deliveries.service";
import { DiscordHelper } from "../discord/discord.helper";
import { EmbedBuilder } from "discord.js";

type PartialObservation = Pick<
  TransformedEBirdObservation,
  | "speciesCode"
  | "subId"
  | "locId"
  | "comName"
  | "sciName"
  | "howMany"
  | "photoCount"
  | "audioCount"
  | "videoCount"
> & {
  obsDt: Date;
  location: {
    id: string;
    name: string;
    isPrivate: boolean;
    county: string;
  };
};

@Injectable()
export class DispatcherService {
  private readonly logger = new Logger(DispatcherService.name);

  constructor(
    private readonly repo: DispatcherRepository,
    private readonly drizzle: DrizzleService,
    private readonly deliveries: DeliveriesService,
    private readonly discordHelper: DiscordHelper
  ) {}

  async dispatchNewEBirdAlerts(since: Date) {
    const recentObs = await this.drizzle.db.query.observations.findMany({
      columns: {
        speciesCode: true,
        subId: true,
        locId: true,
        comName: true,
        sciName: true,
        obsDt: true,
        howMany: true,
        photoCount: true,
        videoCount: true,
        audioCount: true,
      },
      with: {
        location: {
          columns: {
            id: true,
            name: true,
            isPrivate: true,
            county: true,
          },
        },
      },
      where: gt(observations.createdAt, since),
    });

    if (recentObs.length === 0) {
      this.logger.log("No new observations");
      return;
    }

    this.logger.log(
      `Found ${recentObs.length} new observations since ${since.toISOString()}`
    );

    for (const obs of recentObs) {
      await this.dispatchEBirdObservation(obs);
    }
  }

  async dispatchEBirdObservation(obs: PartialObservation) {
    const alertId = `${obs.speciesCode}:${obs.subId}`;
    const channelIds = await this.repo.getMatchingChannelsForObservation(
      obs.comName,
      obs.locId
    );
    if (channelIds.length === 0) return;

    for (const channelId of channelIds) {
      const notYetSent = await this.deliveries.ensureNotDelivered(
        "ebird",
        alertId,
        channelId
      );
      if (!notYetSent) continue;

      try {
        await this.discordHelper.sendEmbedToChannel(
          channelId,
          this.generateEmbed(obs)
        );
        await this.deliveries.recordDelivery("ebird", alertId, channelId);
      } catch (err) {
        this.logger.error(
          `Failed to send ${alertId} to ${channelId}: ${alertId}`
        );
      }
    }
  }

  private generateEmbed(obs: PartialObservation) {
    const locationText =
      "Reported at " +
      (obs.location.isPrivate
        ? "a private location"
        : `[${obs.location.name}](https://ebird.org/hotspot/${obs.location.id})`);

    const embed = new EmbedBuilder()
      .setTitle(`${obs.comName} - ${obs.location.county}`)
      .setURL(`https://ebird.org/checklist/${obs.subId}`)
      .setDescription(
        `${locationText}\nLatest report: ${obs.obsDt.toLocaleString("en-US")}`
      );

    const mediaTexts: string[] = [];
    if (obs.photoCount > 0) mediaTexts.push(`📷 ${obs.photoCount} photo(s)`);
    if (obs.audioCount > 0) mediaTexts.push(`🔊 ${obs.audioCount} audio`);
    if (obs.videoCount > 0) mediaTexts.push(`🎥 ${obs.videoCount} video(s)`);

    if (mediaTexts.length > 0) {
      embed.addFields({ name: "Details", value: mediaTexts.join(" • ") });
    }

    return embed;
  }

  async getMatchingChannelsForObservation(commonName: string, locId: string) {
    return this.repo.getMatchingChannelsForObservation(commonName, locId);
  }
}
