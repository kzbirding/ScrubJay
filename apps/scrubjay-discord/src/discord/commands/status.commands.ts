import { Injectable } from "@nestjs/common";
import {
  SlashCommand,
  SlashCommandContext,
  Context,
  Options,
} from "necord";
import { EmbedBuilder } from "discord.js";

class StatusOptions {
  bird: string;
  region: string;
}

@Injectable()
@SlashCommand({
  name: "status",
  description: "Show recent status of a bird in a region",
})
export class StatusCommand {
  public async onStatus(
    @Context() [interaction]: SlashCommandContext,
    @Options() options: StatusOptions,
  ) {
    const { bird, region } = options;

    const embed = new EmbedBuilder()
      .setTitle(bird)
      .setDescription(`Region: ${region}`)
      .addFields(
        { name: "Status", value: "🚧 Not implemented yet", inline: true },
        { name: "Last reported", value: "—", inline: true },
        { name: "Trend", value: "—", inline: true },
      )
      .setFooter({ text: "ScrubJay (eBird data coming next)" });

    await interaction.reply({ embeds: [embed] });
  }
}
