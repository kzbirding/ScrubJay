import { Injectable, Logger } from "@nestjs/common";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionsBitField,
  type ButtonInteraction,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import { Context, On, Options, Subcommand, type SlashCommandContext } from "necord";

import { MeetupCommand } from "./meetup.decorator";
import { MeetupCreateDto, MeetupPreviewDto } from "./meetup.dto";
import { parseMeetupTimes } from "./meetup.time";
import { MeetupBoardService } from "./meetup.board.service";

function makeId() {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function canManageThread(interaction: any, thread: ThreadChannel): boolean {
  const member = interaction.member;
  if (!member) return false;

  const perms = thread.permissionsFor(member);
  return Boolean(perms?.has(PermissionsBitField.Flags.ManageThreads));
}

function isThreadOwner(interaction: any, thread: ThreadChannel): boolean {
  const ownerId = (thread as any).ownerId as string | null | undefined;
  return Boolean(ownerId && interaction.user?.id === ownerId);
}

function canCancelOrClose(interaction: any, thread: ThreadChannel): boolean {
  return isThreadOwner(interaction, thread) || canManageThread(interaction, thread);
}

function validateFutureTimes(startUnix: number, endUnix?: number): string | null {
  const nowUnix = Math.floor(Date.now() / 1000);
  if (startUnix <= nowUnix) return "Start time must be in the future.";
  if (endUnix && endUnix <= startUnix) return "End time must be after the start time.";
  return null;
}

function extractRoleIdMarker(text: string): string | null {
  const m = text.match(/RSVP_ROLE_ID:([0-9]+)/);
  return m?.[1] ?? null;
}

@Injectable()
@MeetupCommand()
export class MeetupCommands {
  private readonly logger = new Logger(MeetupCommands.name);

  public constructor(private readonly board: MeetupBoardService) {}

  // =========================
  // RSVP button handler
  // =========================
  @On("interactionCreate")
  public async onInteractionCreate([i]: [any]) {
    try {
      if (!i?.isButton?.()) return;

      const bi = i as ButtonInteraction;
      const id = bi.customId || "";

      if (!id.startsWith("meetup_rsvp:")) return;

      // customId format: meetup_rsvp:<action>
      const [, action] = id.split(":");

      // must be used inside a thread
      const ch = bi.channel;
      if (
        !ch ||
        (ch.type !== ChannelType.PublicThread && ch.type !== ChannelType.PrivateThread)
      ) {
        return bi.reply({ ephemeral: true, content: "RSVP buttons only work in meetup threads." });
      }

      const thread = ch as ThreadChannel;

      // Find the RSVP role id from the RSVP panel message (pinned)
      const roleId = await this.findRsvpRoleIdInThread(thread);
      if (!roleId) {
        return bi.reply({
          ephemeral: true,
          content: "RSVP role not found for this meetup (ask a mod to recreate the meetup).",
        });
      }

      const member = bi.member as any;
      if (!member?.roles) {
        return bi.reply({ ephemeral: true, content: "Couldn’t access your server roles." });
      }

      if (action === "go") {
        await member.roles.add(roleId).catch(() => null);
        return bi.reply({ ephemeral: true, content: "✅ You’re marked as **Going**." });
      }

      if (action === "no") {
        await member.roles.remove(roleId).catch(() => null);
        return bi.reply({ ephemeral: true, content: "❌ You’re marked as **Not going**." });
      }

      // maybe = no role (just a lightweight response)
      if (action === "maybe") {
        // ensure they don't have the ping role
        await member.roles.remove(roleId).catch(() => null);
        return bi.reply({ ephemeral: true, content: "🤔 You’re marked as **Maybe** (no pings)." });
      }

      return bi.reply({ ephemeral: true, content: "Unknown RSVP action." });
    } catch (e) {
      this.logger.warn(`RSVP interaction failed: ${e}`);
      try {
        // avoid “interaction failed” banner
        if (typeof (e as any)?.deferred === "boolean") return;
      } catch {}
    }
  }

  // =========================
  // Commands
  // =========================
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
    description: "Create a meetup",
  })
  public async onCreate(
    @Context() [interaction]: SlashCommandContext,
    @Options() options: MeetupCreateDto,
  ) {
    await interaction.deferReply({ ephemeral: true });

    try {
      const { startUnix, endUnix } = parseMeetupTimes(
        options.date,
        options.startTime,
        options.endTime,
      );

      const timeErr = validateFutureTimes(startUnix, endUnix);
      if (timeErr) return interaction.editReply(timeErr);

      const channel = interaction.channel;
      if (!channel || channel.type !== ChannelType.GuildText) {
        return interaction.editReply("This command must be used in a text channel.");
      }
      const textChannel = channel as TextChannel;

      const meetupId = makeId();

      // 1) Post starter message
      const starterText = this.buildThreadStarter(options, startUnix, endUnix);
      const starterMsg = await textChannel.send({ content: starterText });

      // 2) Create thread
      const thread = await starterMsg.startThread({
        name: `Meetup • ${options.title}`.slice(0, 100),
        autoArchiveDuration: 1440,
        reason: "ScrubJay meetup create",
      });

      await starterMsg.pin();

      // 2.5) AUTO: Create RSVP role + post RSVP panel (required)
      const rsvpRoleId = await this.createRsvpRole(interaction, options);
      if (rsvpRoleId) {
        await this.postRsvpPanel(thread, rsvpRoleId, options);
      }

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
        this.logger.warn(`Event create failed (ok): ${err}`);
      }

      // 4) Store meetup + update board (RAM only; wiped on restart)
      this.board.upsert({
        id: meetupId,
        guildId: interaction.guildId!,
        creatorId: interaction.user.id,
        title: options.title,
        location: options.location,
        startUnix,
        threadId: thread.id,
        threadUrl: thread.url,
        eventUrl,
        status: "SCHEDULED",
      });

      await this.board.renderToBoard(interaction.client);

      return interaction.editReply(
        [
          "✅ Meetup created.",
          `Thread: ${thread.url}`,
          eventUrl ? `Event: ${eventUrl}` : "Event: (not created / missing perms)",
          "",
          "RSVP panel posted automatically in the thread.",
          "Run `/meetup edit`, `/meetup cancel`, or `/meetup close` inside the thread.",
        ].join("\n"),
      );
    } catch (err: any) {
      this.logger.error(`Meetup create failed: ${err}`);
      return interaction.editReply(err?.message ?? "Meetup create failed.");
    }
  }

  @Subcommand({
    name: "edit",
    description: "Edit meetup details (run inside the meetup thread)",
  })
  public async onEdit(
    @Context() [interaction]: SlashCommandContext,
    @Options() options: MeetupCreateDto,
  ) {
    const ch = interaction.channel;

    if (
      !ch ||
      (ch.type !== ChannelType.PublicThread && ch.type !== ChannelType.PrivateThread)
    ) {
      return interaction.reply({
        ephemeral: true,
        content: "Run this command inside the meetup thread you want to edit.",
      });
    }

    const thread = ch as ThreadChannel;

    if (!canCancelOrClose(interaction, thread)) {
      return interaction.reply({
        ephemeral: true,
        content: "Only the thread creator or a moderator can edit this meetup.",
      });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const { startUnix, endUnix } = parseMeetupTimes(
        options.date,
        options.startTime,
        options.endTime,
      );

      const timeErr = validateFutureTimes(startUnix, endUnix);
      if (timeErr) return interaction.editReply(timeErr);

      // Update starter message (null-safe)
      const starterMsg = await thread.fetchStarterMessage();
      if (!starterMsg) {
        return interaction.editReply(
          "I couldn't find the thread starter message to edit (it may have been deleted).",
        );
      }
      const newStarterText = this.buildThreadStarter(options, startUnix, endUnix);
      await starterMsg.edit({ content: newStarterText });

      // Rename thread to match
      await thread.setName(`Meetup • ${options.title}`.slice(0, 100));

      // Best-effort: update in-memory record + board
      const m = this.board.getByThreadId(thread.id);
      if (m) {
        this.board.upsert({
          ...m,
          title: options.title,
          location: options.location,
          startUnix,
        });
        await this.board.renderToBoard(interaction.client);
      }

      // Best-effort: update scheduled event if we have eventUrl + perms
      if (m?.eventUrl && interaction.guild) {
        try {
          const parts = m.eventUrl.split("/");
          const eventId = parts[parts.length - 1];
          const event = await interaction.guild.scheduledEvents.fetch(eventId);

          await event.edit({
            name: options.title.slice(0, 100),
            scheduledStartTime: new Date(startUnix * 1000),
            scheduledEndTime: endUnix ? new Date(endUnix * 1000) : undefined, // <-- FIX
            entityMetadata: { location: options.location.slice(0, 100) },
            description: this.buildEventDescription(options),
          });
        } catch (e) {
          this.logger.warn(`Event edit failed (ok): ${e}`);
        }
      }

      await thread.send("✏️ **Meetup details updated.**");

      return interaction.editReply("✅ Updated.");
    } catch (err: any) {
      this.logger.error(`Meetup edit failed: ${err}`);
      return interaction.editReply(err?.message ?? "Edit failed.");
    }
  }

  @Subcommand({
    name: "cancel",
    description: "Cancel a meetup (run inside the meetup thread)",
  })
  public async onCancel(@Context() [interaction]: SlashCommandContext) {
    const ch = interaction.channel;

    if (
      !ch ||
      (ch.type !== ChannelType.PublicThread && ch.type !== ChannelType.PrivateThread)
    ) {
      return interaction.reply({
        ephemeral: true,
        content: "Run this command inside the meetup thread you want to cancel.",
      });
    }

    const thread = ch as ThreadChannel;

    if (!canCancelOrClose(interaction, thread)) {
      return interaction.reply({
        ephemeral: true,
        content: "Only the thread creator or a moderator can cancel this meetup.",
      });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      // Delete RSVP role first (best-effort)
      await this.deleteRsvpRoleIfPresent(interaction, thread);

      if (thread.archived) {
        await thread.setArchived(false, "Temporarily unarchive to post cancel message");
      }
      if (thread.locked) {
        await thread.setLocked(false, "Temporarily unlock to post cancel message");
      }

      await thread.send("❌ **This meetup has been canceled.**");

      await thread.setLocked(true, "Meetup canceled");
      await thread.setArchived(true, "Meetup canceled");

      const m = this.board.getByThreadId(thread.id);
      if (m) {
        this.board.setStatus(m.id, "CANCELED");
        await this.board.renderToBoard(interaction.client);
      }

      return interaction.editReply("✅ Canceled. Thread archived/locked.");
    } catch (err: any) {
      this.logger.error(`Meetup cancel failed: ${err}`);
      return interaction.editReply(err?.message ?? "Cancel failed.");
    }
  }

  @Subcommand({
    name: "close",
    description: "Mark a meetup as completed (run inside the meetup thread)",
  })
  public async onClose(@Context() [interaction]: SlashCommandContext) {
    const ch = interaction.channel;

    if (
      !ch ||
      (ch.type !== ChannelType.PublicThread && ch.type !== ChannelType.PrivateThread)
    ) {
      return interaction.reply({
        ephemeral: true,
        content: "Run this command inside the meetup thread you want to close.",
      });
    }

    const thread = ch as ThreadChannel;

    if (!canCancelOrClose(interaction, thread)) {
      return interaction.reply({
        ephemeral: true,
        content: "Only the thread creator or a moderator can close this meetup.",
      });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      // Delete RSVP role first (best-effort)
      await this.deleteRsvpRoleIfPresent(interaction, thread);

      if (thread.archived) {
        await thread.setArchived(false, "Temporarily unarchive to post close message");
      }
      if (thread.locked) {
        await thread.setLocked(false, "Temporarily unlock to post close message");
      }

      await thread.send("✅ **This meetup has been marked as completed.**");

      await thread.setLocked(true, "Meetup closed");
      await thread.setArchived(true, "Meetup closed");

      const m = this.board.getByThreadId(thread.id);
      if (m) {
        this.board.setStatus(m.id, "CLOSED");
        await this.board.renderToBoard(interaction.client);
      }

      return interaction.editReply("✅ Closed. Thread archived/locked.");
    } catch (err: any) {
      this.logger.error(`Meetup close failed: ${err}`);
      return interaction.editReply(err?.message ?? "Close failed.");
    }
  }

  // =========================
  // RSVP helpers
  // =========================
  private async createRsvpRole(interaction: any, options: MeetupCreateDto): Promise<string | null> {
    try {
      const guild = interaction.guild;
      if (!guild) return null;

      const roleName = `Meetup • ${options.title}`.slice(0, 90);

      const role = await guild.roles.create({
        name: roleName,
        mentionable: true,
        reason: "ScrubJay meetup RSVP role",
      });

      return role.id;
    } catch (e) {
      this.logger.warn(`RSVP role create failed (missing perms ok): ${e}`);
      return null;
    }
  }

  private async postRsvpPanel(thread: ThreadChannel, roleId: string, options: MeetupCreateDto) {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("meetup_rsvp:go")
        .setLabel("✅ Going")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("meetup_rsvp:maybe")
        .setLabel("🤔 Maybe")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("meetup_rsvp:no")
        .setLabel("❌ Not going")
        .setStyle(ButtonStyle.Danger),
    );

    const content = [
      "🗓️ **RSVP for this meetup**",
      "",
      `✅ **Going** → get the ping role (<@&${roleId}>)`,
      "🤔 **Maybe** → no pings",
      "❌ **Not going** → removes the ping role",
      "",
      "Mods/organizer can ping attendees with the role mention above.",
      `||RSVP_ROLE_ID:${roleId}||`,
    ].join("\n");

    const msg = await thread.send({ content, components: [row] });
    await msg.pin().catch(() => null);
  }

  private async findRsvpRoleIdInThread(thread: ThreadChannel): Promise<string | null> {
    try {
      const pinned = await thread.messages.fetchPinned();
      const msg = pinned.find((m) => (m.content || "").includes("RSVP_ROLE_ID:"));
      if (!msg) return null;
      return extractRoleIdMarker(msg.content || "");
    } catch {
      return null;
    }
  }

  private async deleteRsvpRoleIfPresent(interaction: any, thread: ThreadChannel) {
    try {
      const guild = interaction.guild;
      if (!guild) return;

      const roleId = await this.findRsvpRoleIdInThread(thread);
      if (!roleId) return;

      const role = await guild.roles.fetch(roleId).catch(() => null);
      if (!role) return;

      await role.delete("ScrubJay meetup ended/canceled").catch(() => null);
    } catch (e) {
      this.logger.warn(`RSVP role delete failed (ok): ${e}`);
    }
  }

  // =========================
  // Text builders
  // =========================
  private buildEventDescription(options: MeetupPreviewDto) {
    const lines: string[] = [];
    lines.push("ScrubJay Meetup");
    if (options.skillLevel) lines.push(`Skill level: ${options.skillLevel}`);
    if (options.notes) lines.push(`Notes: ${options.notes}`);
    lines.push("");
    lines.push(
      "Safety: 18+ only. No personal info required. No DMs. Keep coordination in the thread.",
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
    lines.push("• No DMs. Keep coordination in this thread.");
    lines.push("• Use good judgment; moderators may intervene for safety.");
    lines.push("");
    lines.push("✅ RSVP tools will appear below.");

    return lines.join("\n");
  }
}
