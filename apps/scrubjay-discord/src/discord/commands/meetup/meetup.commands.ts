import { Injectable, Logger } from "@nestjs/common";
import { ChannelType, type TextChannel } from "discord.js";
import { Context, Options, Subcommand, type SlashCommandContext } from "necord";

import { MeetupCommand } from "./meetup.decorator";
import { MeetupCreateDto, MeetupPreviewDto } from "./meetup.dto";
import { assertSandboxAllowed } from "./meetup.sandbox";
import { parseMeetupTimes } from "./meetup.time";
import { MeetupBoardService } from "./meetup.board.service";

function makeId() {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

@Injectable()
@MeetupCommand()
export class MeetupCommands {
  private readonly logger = new Logger(MeetupCommands.name);

  public constructor(private readonly board: MeetupBoardService) {}

  @Subcommand({
    name: "preview",
    description: "Preview a meetup (no changes made)",
  })
  public async onPreview(
    @Context() [interaction]: SlashCommandContext,
    @Options() options: MeetupPreviewDto,
  ) {
    try {
      const { startUnix, endUnix } = parseMeetupTimes(
        options.date,
        options.startTime,
        options.endTime,
      );

      const starter = this.buildThreadStarter(options, startUnix, endUnix);

      return interaction.reply({
        ephemeral: true,
        content:
          [
            "**Meetup Preview (no changes made)**",
            `**Title:** ${options.title}`,
            `**When:** <t:${startUnix}:f>${endUnix ? ` – <t:${endUnix}:t>` : ""}  (<t:${startUnix}:R>)`,
            `**Location:** ${options.location}`,
            options.skillLevel ? `**Skill level:** ${options.skillLevel}` : null,
            options.notes ? `**Notes:** ${options.notes}` : null,
            "",
            "**Thread starter text:**",
            "```",
            starter.length > 1800 ? starter.slice(0, 1800) + "…" : starter,
            "```",
            "",
            "**Board entry:**",
            `• <t:${startUnix}:f> — ${options.title} (${options.location})`,
          ]
            .filter(Boolean)
            .join("\n"),
      });
    } catch (e: any) {
      return interaction.reply({
        ephemeral: true,
        content: e?.message ?? "Invalid meetup input.",
      });
    }
  }

  @Subcommand({
    name: "create",
    description: "Create a meetup (sandbox-only for now)",
  })
  public async onCreate(
    @Context() [interaction]: SlashCommandContext,
    @Options() options: MeetupCreateDto,
  ) {
    const gate = assertSandboxAllowed(interaction);
    if (!gate.ok) {
      return interaction.reply({ content: gate.reason, ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const { startUnix, endUnix } = parseMeetupTimes(
        options.date,
        options.startTime,
        options.endTime,
      );

      const channel = interaction.channel;
      if (!channel || channel.type !== ChannelType.GuildText) {
        return interaction.editReply("This command must be used in a text channel.");
      }
      const textChannel = channel as TextChannel;

      const meetupId = makeId();

      // 1) Post starter message in sandbox channel
      const starterText = this.buildThreadStarter(options, startUnix, endUnix);
      const starterMsg = await textChannel.send({ content: starterText });

      // 2) Create thread
      const thread = await starterMsg.startThread({
        name: `Meetup • ${options.title}`.slice(0, 100),
        autoArchiveDuration: 1440, // 24h
        reason: "ScrubJay meetup create (sandbox)",
      });

      await starterMsg.pin();

      // 3) Try scheduled event (if perms missing, we continue)
      let eventUrl: string | undefined;
      try {
        if (interaction.guild) {
          const event = await interaction.guild.scheduledEvents.create({
            name: options.title.slice(0, 100),
            scheduledStartTime: new Date(startUnix * 1000),
            scheduledEndTime: endUnix ? new Date(endUnix * 1000) : undefined,
            privacyLevel: 2, // GUILD_ONLY
            entityType: 3, // EXTERNAL
            entityMetadata: { location: options.location.slice(0, 100) },
            description: this.buildEventDescription(options),
          });

          eventUrl = `https://discord.com/events/${interaction.guildId}/${event.id}`;
        }
      } catch (err) {
        this.logger.warn(`Event create failed (sandbox ok): ${err}`);
      }

      // 4) Update pinned board message
      this.board.upsert({
        id: meetupId,
        title: options.title,
        location: options.location,
        startUnix,
        threadUrl: thread.url,
        eventUrl,
        status: "SCHEDULED",
      });

      await this.board.renderToBoard(interaction.client);

      return interaction.editReply(
        [
          "✅ Meetup created (sandbox).",
          `Thread: ${thread.url}`,
          eventUrl ? `Event: ${eventUrl}` : "Event: (not created / missing perms)",
        ].join("\n"),
      );
    } catch (err: any) {
      this.logger.error(`Meetup create failed: ${err}`);
      return interaction.editReply(err?.message ?? "Meetup create failed.");
    }
  }

  private buildEventDescription(options: MeetupPreviewDto) {
    const lines: string[] = [];
    lines.push("ScrubJay Meetup");
    if (options.skillLevel) lines.push(`Skill level: ${options.skillLevel}`);
    if (options.notes) lines.push(`Notes: ${options.notes}`);
    lines.push("");
    lines.push(
      "Safety: 18+ only. No personal info required. No bot DMs. Keep coordination in the thread.",
    );
    return lines.join("\n").slice(0, 900);
  }

  private buildThreadStarter(
    options: MeetupPreviewDto,
    startUnix: number,
    endUnix?: number,
  ) {
    const lines: string[] = [];

    lines.push(`🗓️ **${options.title}**`);
    lines.push(
      `⏰ **When:** <t:${startUnix}:f>${endUnix ? ` – <t:${endUnix}:t>` : ""}  (<t:${startUnix}:R>)`,
    );
    lines.push(`📍 **Where:** ${options.location}`);
    if (options.skillLevel) lines.push(`🎯 **Skill level:** ${options.skillLevel}`);
    if (options.notes) lines.push(`📝 **Notes:** ${options.notes}`);
    lines.push("");
    lines.push("🛡️ **Safety / Rules**");
    lines.push("• 18+ only. No personal info required (no names/phone numbers).");
    lines.push("• No bot DMs. Keep coordination in this thread.");
    lines.push("• Use good judgment; moderators may intervene for safety.");
    lines.push("");
    lines.push("✅ RSVP tools may appear here later (sandbox MVP).");

    return lines.join("\n");
  }
}
