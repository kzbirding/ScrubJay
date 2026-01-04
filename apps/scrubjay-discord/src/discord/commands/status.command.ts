import { Injectable } from "@nestjs/common";
import { EmbedBuilder } from "discord.js";
import {
  Context,
  Options,
  SlashCommand,
  SlashCommandContext,
  StringOption,
} from "necord";

class StatusOptions {
  @StringOption({
    name: "bird",
    description: "Bird name (ex: California Gnatcatcher)",
    required: true,
  })
  bird!: string;

  @StringOption({
    name: "region",
    description: "Region (ex: San Diego)",
    required: true,
  })
  region!: string;
}

@Injectable()
export class StatusCommand {
  @SlashCommand({
    name: "status",
    description: "Show recent status of a bird in a region",
  })
  public async status(
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
