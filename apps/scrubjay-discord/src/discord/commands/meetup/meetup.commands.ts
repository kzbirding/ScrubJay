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

// ✅ /meetup create channel gate
function assertMeetupCreateChannel(interaction: any): string | null {
  const allowedId = process.env.MEETUP_CHANNEL_ID;
  if (!allowedId) return "MEETUP_CHANNEL_ID is not set on the bot.";

  const ch = interaction.channel;
  if (!ch || ch.type !== ChannelType.GuildText) {
    return `Use this command in <#${allowedId}>.`;
  }

  if (ch.id !== allowedId) {
    return `Use this command in <#${allowedId}>.`;
  }

  return null;
}

function buildRsvpRow(roleId: string) {
  // format: meetup_rsvp:<action>:<roleId>
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`meetup_rsvp:go:${roleId}`)
      .setLabel("✅ Going")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`meetup_rsvp:maybe:${roleId}`)
      .setLabel("🤔 Maybe")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`meetup_rsvp:no:${roleId}`)
      .setLabel("❌ Not going")
      .setStyle(ButtonStyle.Danger),
  );
}

function parseRsvpCustomId(
  customId: string,
): { action: "go" | "maybe" | "no"; roleId: string } | null {
  if (!customId.startsWith("meetup_rsvp:")) return null;
  const parts = customId.split(":");
  // ["meetup_rsvp", "<action>", "<roleId>"]
  if (parts.length !== 3) return null;

  const action = parts[1] as any;
  const roleId = parts[2];

  if (action !== "go" && action !== "maybe" && action !== "no") return null;
  if (!/^\d+$/.test(roleId)) return null;

  return { action, roleId };
}

function getRoleIdFromMessageComponents(msg: any): string | null {
  try {
    const comps = msg?.components ?? [];
    for (const row of comps) {
      const rowComps = row?.components ?? [];
      for (const c of rowComps) {
        const parsed = parseRsvpCustomId(c?.customId ?? "");
        if (parsed?.roleId) return parsed.roleId;
      }
    }
    return null;
  } catch {
    return null;
  }
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
      const parsed = parseRsvpCustomId(bi.customId || "");
      if (!parsed) return;

      // Must be in a guild (roles)
      if (!bi.guild) {
        return bi.reply({ ephemeral: true, content: "RSVP only works in a server." });
      }

      const member = bi.member as any;
      if (!member?.roles) {
        return bi.reply({ ephemeral: true, content: "Couldn’t access your server roles." });
      }

      const { action, roleId } = parsed;

      if (action === "go") {
        await member.roles.add(roleId).catch(() => null);
        return bi.reply({ ephemeral: true, content: "✅ You’re marked as **Going**." });
      }

      if (action === "no") {
        await member.roles.remove(roleId).catch(() => null);
        return bi.reply({ ephemeral: true, content: "❌ You’re marked as **Not going**." });
      }

      // maybe = no role (no pings)
      await member.roles.remove(roleId).catch(() => null);
      return bi.reply({ ephemeral: true, content: "🤔 You’re marked as **Maybe** (no pings)." });
    } catch (e) {
      this.logger.warn(`RSVP interaction failed: ${e}`);
      try {
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

      const starter = this.buildMeetupPanelText(options, startUnix, endUnix, null);

      return interaction.reply({
        ephemeral: true,
        content:
          [
            "**Meetup Preview (no changes made)**",
            `**Title:** ${options.title}`,
            `**When:** <t:${startUnix}:f>${endUnix ? ` – <t:${endUnix}:t>` : ""}  (<t:${startUnix}:R>)`,
            `**Location:** ${options.location}`,
            options.notes ? `**Notes:** ${options.notes}` : null,
            "",
            "**Meetup panel text (what will be posted as the thread starter message):**",
            "```",
            starter.length > 1800 ? starter.slice(0, 1800) + "…" : starter,
            "```",
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

    // ✅ Only allow /meetup create in MEETUP_CHANNEL_ID
    const gateErr = assertMeetupCreateChannel(interaction);
    if (gateErr) return interaction.editReply(gateErr);

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

      // Create RSVP role (required)
      const rsvpRoleId = await this.createRsvpRole(interaction, options);
      if (!rsvpRoleId) {
        return interaction.editReply(
          "I couldn’t create the RSVP role. The bot likely needs **Manage Roles** (and its role must be above the roles it creates).",
        );
      }

      const meetupId = makeId();

      // Post the meetup panel as a normal message in the channel (buttons clickable here)
      const panelText = this.buildMeetupPanelText(options, startUnix, endUnix, rsvpRoleId);
      const starterMsg = await textChannel.send({
        content: panelText,
        components: [buildRsvpRow(rsvpRoleId)],
      });

      // Create thread from that message
      const thread = await starterMsg.startThread({
        name: `Meetup • ${options.title}`.slice(0, 100),
        autoArchiveDuration: 1440,
        reason: "ScrubJay meetup create",
      });

      await starterMsg.pin().catch(() => null);

      // Try scheduled event (best-effort)
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

      // Store meetup + update board (RAM only)
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
          "RSVP buttons are on the pinned meetup message in the channel.",
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

      const starterMsg = await thread.fetchStarterMessage().catch(() => null);
      if (!starterMsg) {
        return interaction.editReply(
          "I couldn't find the thread starter message to edit (it may have been deleted).",
        );
      }

      const existingRoleId = getRoleIdFromMessageComponents(starterMsg);
      if (!existingRoleId) {
        return interaction.editReply(
          "I couldn’t find the RSVP buttons on the starter message (they may have been removed).",
        );
      }

      const newText = this.buildMeetupPanelText(options, startUnix, endUnix, existingRoleId);
      await starterMsg.edit({
        content: newText,
        components: [buildRsvpRow(existingRoleId)],
      });

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

      // Best-effort: update scheduled event
      if (m?.eventUrl && interaction.guild) {
        try {
          const parts = m.eventUrl.split("/");
          const eventId = parts[parts.length - 1];
          const event = await interaction.guild.scheduledEvents.fetch(eventId);

          await event.edit({
            name: options.title.slice(0, 100),
            scheduledStartTime: new Date(startUnix * 1000),
            scheduledEndTime: endUnix ? new Date(endUnix * 1000) : undefined,
            entityMetadata: { location: options.location.slice(0, 100) },
            description: this.buildEventDescription(options),
          });
        } catch (e) {
          this.logger.warn(`Event edit failed (ok): ${e}`);
        }
      }

      await thread.send("✏️ **Meetup details updated.**").catch(() => null);
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
      if (thread.archived) {
        await thread.setArchived(false, "Temporarily unarchive to post cancel message");
      }
      if (thread.locked) {
        await thread.setLocked(false, "Temporarily unlock to post cancel message");
      }

      const roleId = await this.getRsvpRoleIdFromStarterMessage(thread);
      const canceller = `<@${interaction.user.id}>`;

      if (roleId) {
        await thread
          .send(
            [
              `<@&${roleId}>`,
              "❌ **This meetup has been canceled.**",
              `Canceled by: ${canceller}`,
            ].join("\n"),
          )
          .catch(() => null);

        await this.deleteRsvpRoleById(interaction, roleId);
      } else {
        await thread
          .send(["❌ **This meetup has been canceled.**", `Canceled by: ${canceller}`].join("\n"))
          .catch(() => null);
      }

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
      if (thread.archived) {
        await thread.setArchived(false, "Temporarily unarchive to post close message");
      }
      if (thread.locked) {
        await thread.setLocked(false, "Temporarily unlock to post close message");
      }

      const roleId = await this.getRsvpRoleIdFromStarterMessage(thread);
      if (roleId) {
        await this.deleteRsvpRoleById(interaction, roleId);
      }

      await thread.send("✅ **This meetup has been marked as completed.**").catch(() => null);

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
  // Helpers
  // =========================
  private async createRsvpRole(interaction: any, options: MeetupCreateDto): Promise<string | null> {
    try {
      const guild = interaction.guild;
      if (!guild) return null;

      // ✅ Make role name unique/readable by including date + start time
      const roleDate = (() => {
        const [y, m, d] = (options.date || "").split("-");
        if (!y || !m || !d) return options.date || "";
        const mm = String(Number(m));
        const dd = String(Number(d));
        return `${mm}/${dd}`;
      })();

      const roleTime = (options.startTime || "").trim(); // e.g. "07:30"
      const roleName = `Meetup • ${options.title} ${roleDate}${roleTime ? ` ${roleTime}` : ""}`.slice(
        0,
        100,
      );

      const role = await guild.roles.create({
        name: roleName,
        mentionable: true,
        reason: "ScrubJay meetup RSVP role",
      });

      return role.id;
    } catch (e) {
      this.logger.warn(`RSVP role create failed: ${e}`);
      return null;
    }
  }

  private async getRsvpRoleIdFromStarterMessage(thread: ThreadChannel): Promise<string | null> {
    const starterMsg = await thread.fetchStarterMessage().catch(() => null);
    if (!starterMsg) return null;
    return getRoleIdFromMessageComponents(starterMsg);
  }

  private async deleteRsvpRoleById(interaction: any, roleId: string) {
    try {
      const guild = interaction.guild;
      if (!guild) return;

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
    if (options.notes) lines.push(`Notes: ${options.notes}`);
    lines.push("");
    lines.push(
      "Safety: 18+ only. No personal info required. No DMs. Keep coordination in the thread.",
    );
    return lines.join("\n").slice(0, 900);
  }

  private buildMeetupPanelText(
    options: MeetupPreviewDto,
    startUnix: number,
    endUnix: number | undefined,
    rsvpRoleId: string | null,
  ) {
    const lines: string[] = [];

    lines.push(`🗓️ **${options.title}**`);
    lines.push(
      `⏰ **When:** <t:${startUnix}:f>${endUnix ? ` – <t:${endUnix}:t>` : ""}  (<t:${startUnix}:R>)`,
    );
    lines.push(`📍 **Where:** ${options.location}`);
    if (options.notes) lines.push(`📝 **Notes:** ${options.notes}`);

    lines.push("");
    lines.push("🛡️ **Safety / Rules**");
    lines.push("• 18+ only. No personal info required (no names/phone numbers).");
    lines.push("• No DMs. Keep coordination in the thread.");
    lines.push("• Use good judgment; moderators may intervene for safety.");

    lines.push("");
    lines.push("✅ **RSVP (use the buttons below)**");
    if (rsvpRoleId) {
      lines.push(`• **Going** = you get the ping role: <@&${rsvpRoleId}>`);
      lines.push("• **Maybe** = no pings");
      lines.push("• **Not going** = removes the ping role");
      lines.push("• Organizer/mods can ping attendees by mentioning the role above.");
    } else {
      lines.push("• (Preview only) RSVP role will be created automatically on real meetups.");
    }

    return lines.join("\n");
  }
}
