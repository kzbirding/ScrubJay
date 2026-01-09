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
  type Message,
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

// =========================
// Organizer + Attendance helpers
// =========================
const ATTENDANCE_TAG = "[SCRUBJAY_MEETUP_ATTENDANCE]";
const ORGANIZER_TAG_PREFIX = "(OrganizerId:"; // stored in panel text for persistence across redeploys
const ORGANIZER_TAG_RE = /\(OrganizerId:(\d+)\)/;

function getOrganizerIdFromPanelText(text: string): string | null {
  const m = (text ?? "").match(ORGANIZER_TAG_RE);
  return m?.[1] ?? null;
}

// Helper: build unique role name from meetup inputs
function buildRsvpRoleNameFromOptions(options: MeetupCreateDto | MeetupPreviewDto): string {
  const roleDate = (() => {
    const [y, m, d] = (options.date || "").split("-");
    if (!y || !m || !d) return (options.date || "").trim();
    const mm = String(Number(m));
    const dd = String(Number(d));
    return `${mm}/${dd}`;
  })();

  const roleTime = (options.startTime || "").trim(); // e.g. "07:30"
  const base = `Meetup • ${options.title} ${roleDate}${roleTime ? ` ${roleTime}` : ""}`;
  return base.slice(0, 100);
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

      // Apply role changes
      if (action === "go") {
        await member.roles.add(roleId).catch(() => null);
        await this.tryUpdateAttendanceFromButton(bi, roleId);
        return bi.reply({ ephemeral: true, content: "✅ You’re marked as **Going**." });
      }

      if (action === "no") {
        await member.roles.remove(roleId).catch(() => null);
        await this.tryUpdateAttendanceFromButton(bi, roleId);
        return bi.reply({ ephemeral: true, content: "❌ You’re marked as **Not going**." });
      }

      // maybe = no role (no pings)
      await member.roles.remove(roleId).catch(() => null);
      await this.tryUpdateAttendanceFromButton(bi, roleId);
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

      // Preview uses the person previewing as the organizer, purely for display.
      const starter = this.buildMeetupPanelText(
        options,
        startUnix,
        endUnix,
        null,
        interaction.user?.id ?? null,
        null, // no RSVP link in preview
      );

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

      // Organizer is the user who ran /meetup create
      const organizerId = interaction.user?.id ?? null;

      // Create RSVP role (required)
      const rsvpRoleId = await this.createRsvpRole(interaction, options);
      if (!rsvpRoleId) {
        return interaction.editReply(
          "I couldn’t create the RSVP role. The bot likely needs **Manage Roles** (and its role must be above the roles it creates).",
        );
      }

      const meetupId = makeId();

      // Post the meetup panel as a normal message in the channel (buttons clickable here)
      // (We don’t know the URL until after send — so send once, then edit to inject the link.)
      const initialPanelText = this.buildMeetupPanelText(
        options,
        startUnix,
        endUnix,
        rsvpRoleId,
        organizerId,
        null,
      );

      const starterMsg = await textChannel.send({
        content: initialPanelText,
        components: [buildRsvpRow(rsvpRoleId)],
      });

      // Now we can include a direct link back to the RSVP message for thread viewers
      const finalPanelText = this.buildMeetupPanelText(
        options,
        startUnix,
        endUnix,
        rsvpRoleId,
        organizerId,
        starterMsg.url,
      );
      await starterMsg.edit({ content: finalPanelText }).catch(() => null);

      // Create thread from that message
      const thread = await starterMsg.startThread({
        name: `Meetup • ${options.title}`.slice(0, 100),
        autoArchiveDuration: 1440,
        reason: "ScrubJay meetup create",
      });

      // ❌ Do NOT pin the parent channel message

      // ✅ Pin the meetup panel INSIDE the thread (starter message)
      const threadStarter = await thread.fetchStarterMessage().catch(() => null);
      if (threadStarter) await threadStarter.pin().catch(() => null);

      // ✅ Create / ensure attendance message inside thread (starts empty) — this pins itself
      await this.upsertAttendanceMessage(thread, interaction.guildId!, rsvpRoleId).catch(() => null);

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
          "RSVP buttons are on the meetup message in the channel.",
          "The meetup panel + attendance list are pinned inside the thread.",
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

    // ✅ Organizer/mod check (NOT thread.ownerId — bot owns the thread)
    const canEdit = await this.canManageMeetup(interaction, thread);
    if (!canEdit) {
      return interaction.reply({
        ephemeral: true,
        content: "Only the meetup organizer or a moderator can edit this meetup.",
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

      // ✅ (1) Rename the RSVP role to match the edited meetup parameters
      await this.tryRenameRsvpRole(interaction, existingRoleId, options).catch(() => null);

      // Preserve organizer id from the existing panel (fallback: current user)
      const existingOrganizerId =
        getOrganizerIdFromPanelText(starterMsg.content ?? "") ?? interaction.user?.id ?? null;

      // ✅ include RSVP link back to the parent message URL
      const rsvpMessageUrl = (starterMsg as any)?.url ?? null;

      const newText = this.buildMeetupPanelText(
        options,
        startUnix,
        endUnix,
        existingRoleId,
        existingOrganizerId,
        rsvpMessageUrl,
      );

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

      // ✅ Refresh attendance (in case role membership exists already)
      await this.upsertAttendanceMessage(thread, interaction.guildId!, existingRoleId).catch(
        () => null,
      );

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

    const canCancel = await this.canManageMeetup(interaction, thread);
    if (!canCancel) {
      return interaction.reply({
        ephemeral: true,
        content: "Only the meetup organizer or a moderator can cancel this meetup.",
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

    const canClose = await this.canManageMeetup(interaction, thread);
    if (!canClose) {
      return interaction.reply({
        ephemeral: true,
        content: "Only the meetup organizer or a moderator can close this meetup.",
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
  // Permission helpers
  // =========================
  private async canManageMeetup(interaction: any, thread: ThreadChannel): Promise<boolean> {
    // Mods always allowed
    if (canManageThread(interaction, thread)) return true;

    // Organizer allowed if panel has matching OrganizerId
    const organizerId = await this.getOrganizerIdFromStarterMessage(thread);
    if (!organizerId) return false;
    return interaction?.user?.id === organizerId;
  }

  private async getOrganizerIdFromStarterMessage(thread: ThreadChannel): Promise<string | null> {
    try {
      const starterMsg = await thread.fetchStarterMessage().catch(() => null);
      if (!starterMsg) return null;
      return getOrganizerIdFromPanelText(starterMsg.content ?? "");
    } catch {
      return null;
    }
  }

  // =========================
  // Helpers
  // =========================
  private async createRsvpRole(interaction: any, options: MeetupCreateDto): Promise<string | null> {
    try {
      const guild = interaction.guild;
      if (!guild) return null;

      const roleName = buildRsvpRoleNameFromOptions(options);

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

  private async tryRenameRsvpRole(interaction: any, roleId: string, options: MeetupCreateDto) {
    try {
      const guild = interaction.guild;
      if (!guild) return;

      const role = await guild.roles.fetch(roleId).catch(() => null);
      if (!role) return;

      const newName = buildRsvpRoleNameFromOptions(options);

      // Only edit if changed (reduces API calls)
      if (role.name !== newName) {
        await role.edit({ name: newName, mentionable: true }, "ScrubJay meetup edit: rename RSVP role").catch(
          () => null,
        );
      }
    } catch (e) {
      this.logger.warn(`RSVP role rename failed (ok): ${e}`);
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
  // Attendance logic
  // =========================
  private async tryUpdateAttendanceFromButton(bi: ButtonInteraction, roleId: string) {
    try {
      // Buttons are on the starter message in the parent channel.
      // Discord.js attaches the thread to the message as message.thread if one exists.
      const msg = bi.message as unknown as Message & { thread?: ThreadChannel | null };
      const thread = msg?.thread ?? null;
      if (!thread) return;

      // If thread is archived/locked, we won't be able to edit/send — just skip quietly.
      if (thread.archived && thread.locked) return;

      await this.upsertAttendanceMessage(thread, bi.guildId!, roleId);
    } catch (e) {
      this.logger.warn(`Attendance update failed (ok): ${e}`);
    }
  }

  private async findAttendanceMessage(thread: ThreadChannel): Promise<Message | null> {
    try {
      const pinned = await thread.messages.fetchPinned();
      const found = pinned.find((m) => (m.content ?? "").includes(ATTENDANCE_TAG));
      if (found) return found;

      // If not pinned, try recent history (limit: 50)
      const recent = await thread.messages.fetch({ limit: 50 }).catch(() => null);
      const foundRecent = recent?.find((m) => (m.content ?? "").includes(ATTENDANCE_TAG));
      return foundRecent ?? null;
    } catch {
      return null;
    }
  }

  private buildAttendanceText(mentions: string[]) {
    const lines: string[] = [];
    lines.push(`👥 **Going (${mentions.length})** ${ATTENDANCE_TAG}`);
    lines.push("");

    if (!mentions.length) {
      lines.push("• (No one yet)");
      return lines.join("\n");
    }

    // Keep it readable; Discord message limit is 2000 chars.
    for (const m of mentions) {
      const next = `• ${m}`;
      if (lines.join("\n").length + 1 + next.length > 1900) {
        lines.push("");
        lines.push("…and more");
        break;
      }
      lines.push(next);
    }

    return lines.join("\n");
  }

  private async upsertAttendanceMessage(thread: ThreadChannel, _guildId: string, roleId: string) {
    const guild = thread.guild;
    if (!guild) return;

    const role = await guild.roles.fetch(roleId).catch(() => null);
    if (!role) return;

    // Build list of mentions from the role members
    const mentions = [...role.members.values()]
      .sort((a, b) => (a.displayName ?? "").localeCompare(b.displayName ?? ""))
      .map((m) => `<@${m.id}>`);

    const content = this.buildAttendanceText(mentions);

    const existing = await this.findAttendanceMessage(thread);

    if (existing) {
      await existing.edit({ content }).catch(() => null);
      await existing.pin().catch(() => null);
      return;
    }

    const created = await thread.send({ content }).catch(() => null);
    if (created) await created.pin().catch(() => null);
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
    organizerId: string | null,
    rsvpMessageUrl: string | null, // ✅ link back to RSVP post for thread viewers
  ) {
    const lines: string[] = [];

    lines.push(`🗓️ **${options.title}**`);
    lines.push(
      `⏰ **When:** <t:${startUnix}:f>${endUnix ? ` – <t:${endUnix}:t>` : ""}  (<t:${startUnix}:R>)`,
    );
    lines.push(`📍 **Where:** ${options.location}`);
    if (options.notes) lines.push(`📝 **Notes:** ${options.notes}`);

    // ✅ Organizer (visible + persistent tag for permission checks)
    if (organizerId) {
      lines.push(`🧑‍💼 **Organizer:** <@${organizerId}>`);
      lines.push(`${ORGANIZER_TAG_PREFIX}${organizerId})`);
    }

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

      // ✅ note + link back to the RSVP post
      if (rsvpMessageUrl) {
        lines.push(
          `• ⚠️ **RSVP buttons do not work inside the thread.** Click here to RSVP: ${rsvpMessageUrl}`,
        );
      }
    } else {
      lines.push("• (Preview only) RSVP role will be created automatically on real meetups.");
    }

    return lines.join("\n");
  }
}
