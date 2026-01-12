
const MEETUP_HELP_TEXT = `
**Meetups — quick guide 🌿**

• Use **/meetup create** to host a birding meetup. It'll open a thread for you and place your meetup on the meetup board 
• In the thread, users can RSVP using the buttons in the pinned messages. This will automatically update the attendance list
• A unique role is also created for your meetup, which you can mention for important updates.

• Use **/meetup edit** within the meetup thread edit any aspect of the meetup title, date, time, etc.
• Use **/meetup cancel** within the meetup thread to cancel the meetup and notify all attendees.
• Use **/meetup close** to mark a meetup as complete and archive it.

If you’re unsure, it’s okay to ask in the thread 🙂
`;


import { Injectable, Logger } from "@nestjs/common";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type ButtonInteraction,
  type TextChannel,
  type ThreadChannel,
  type Message,
} from "discord.js";
import { Context, IntegerOption, On, Options, Subcommand, type SlashCommandContext } from "necord";

import { MeetupCommand } from "./meetup.decorator";
import { MeetupCreateDto } from "./meetup.dto";
import { parseMeetupTimes } from "./meetup.time";
import { MeetupBoardService } from "./meetup.board.service";

function makeId() {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function hasModRole(interaction: any): boolean {
  const modRoleId = process.env.MOD_ID;
  if (!modRoleId) return false;

  const member = interaction?.member as any;
  return Boolean(member?.roles?.cache?.has?.(modRoleId));
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

// ✅ /meetup history channel gate (must be run in #meetups)
function assertMeetupHistoryChannel(interaction: any): string | null {
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

class MeetupHistoryDto {
  @IntegerOption({
    name: "page",
    description: "Page number (1 = oldest). Omit for most recent.",
    required: false,
  })
  public page?: number;
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

function getRoleIdFromText(content: string): string | null {
  const m = (content ?? "").match(/<@&(\d+)>/);
  return m?.[1] ?? null;
}

function asMessageArray(pins: any): any[] {
  if (!pins) return [];

  if (typeof pins.values === "function") {
    return Array.from(pins.values());
  }

  const msgs = pins.messages ?? pins;

  if (msgs && typeof msgs.values === "function") {
    return Array.from(msgs.values());
  }

  if (Array.isArray(msgs)) return msgs;

  if (msgs && typeof msgs === "object") {
    return Object.values(msgs);
  }

  return [];
}


// =========================
// Organizer + Attendance helpers
// =========================
const ATTENDANCE_TAG = "[SCRUBJAY_MEETUP_ATTENDANCE]";
const THREAD_PANEL_TAG = "[SCRUBJAY_MEETUP_THREAD_PANEL]";
const ORGANIZER_TAG_PREFIX = "(OrganizerId:"; // stored in panel text for persistence across redeploys
const ORGANIZER_TAG_RE = /\(OrganizerId:(\d+)\)/;

function getOrganizerIdFromPanelText(text: string): string | null {
  const m = (text ?? "").match(ORGANIZER_TAG_RE);
  return m?.[1] ?? null;
}

// Helper: build unique role name from meetup inputs
function buildRsvpRoleNameFromOptions(options: MeetupCreateDto): string {
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

  private readonly trustedOrganizerRoleId = process.env.TRUSTED_ORGANIZER_ROLE_ID ?? null;

  public constructor(private readonly board: MeetupBoardService) {}

  private async getTrustedOrganizerStatus(
    interaction: any,
    userId: string | null,
  ): Promise<boolean | null> {
    const roleId = this.trustedOrganizerRoleId;
    if (!roleId || !userId) return null;

    const guild = interaction?.guild;
    if (!guild) return null;

    try {
      const member = await guild.members.fetch(userId);
      return Boolean(member?.roles?.cache?.has(roleId));
    } catch {
      return null;
    }
  }


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
        await this.tryUpdateAttendanceFromButton(bi, roleId);
        return bi.reply({ ephemeral: true, content: "✅ You’re marked as **Going**." });
      }

      if (action === "no") {
        await member.roles.remove(roleId).catch(() => null);
        await this.tryUpdateAttendanceFromButton(bi, roleId);
        return bi.reply({ ephemeral: true, content: "❌ You’re marked as **Not going**." });
      }

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
    name: "create",
    description: "Create a meetup",
  })
  public async onCreate(
    @Context() [interaction]: SlashCommandContext,
    @Options() options: MeetupCreateDto,
  ) {
    await interaction.deferReply({ ephemeral: true });

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

      const organizerId = interaction.user?.id ?? null;
      const trustedStatus = await this.getTrustedOrganizerStatus(interaction, organizerId);


      const rsvpRoleId = await this.createRsvpRole(interaction, options);
      if (!rsvpRoleId) {
        return interaction.editReply(
          "I couldn’t create the RSVP role. The bot likely needs **Manage Roles** (and its role must be above the roles it creates).",
        );
      }

      // ✅ Auto-add organizer to Going (adds role)
      try {
        const organizerMember = interaction.member as any;
        if (organizerMember?.roles?.add) {
          await organizerMember.roles.add(rsvpRoleId).catch(() => null);
        }
      } catch (e) {
        this.logger.warn(`Could not auto-add organizer to RSVP role (ok): ${e}`);
      }

      const meetupId = makeId();

      // 1) Parent message (NO BUTTONS)
      const initialParentText = this.buildMeetupPanelText(
        options,
        startUnix,
        endUnix,
        rsvpRoleId,
        organizerId,
        trustedStatus,
        null, // thread link not available yet
      );

      const starterMsg = await textChannel.send({
        content: initialParentText,
      });

      // 2) Create thread from the parent message
      const thread = await starterMsg.startThread({
        name: `[${options.county}] ${options.title}`.slice(0, 100),
        autoArchiveDuration: 1440,
        reason: "ScrubJay meetup create",
      });

      // Now that we have the thread URL, update the parent message to include it
      const finalParentText = this.buildMeetupPanelText(
        options,
        startUnix,
        endUnix,
        rsvpRoleId,
        organizerId,
        trustedStatus,
        thread.url,
      );
      await starterMsg.edit({ content: finalParentText, components: [] }).catch(() => null);

      // 2.5) Thread RSVP message (WITH BUTTONS) — keep this one short (parent has the details)
      const rsvpInThread = await thread.send({
        content: this.buildThreadRsvpText(options, startUnix, endUnix, organizerId, rsvpRoleId),
        components: [buildRsvpRow(rsvpRoleId)],
      });
      await rsvpInThread.pin().catch(() => null);

      // 4) Attendance message (pins itself)
      await this.upsertAttendanceMessage(thread, interaction.guildId!, rsvpRoleId).catch(() => null);

      // Try scheduled event (best-effort)
      let eventUrl: string | undefined;
      try {
        if (interaction.guild) {
          const event = await interaction.guild.scheduledEvents.create({
            name: options.title.slice(0, 100),
            scheduledStartTime: new Date(startUnix * 1000),
            scheduledEndTime: endUnix ? new Date(endUnix * 1000) : undefined,
            privacyLevel: 2,
            entityType: 3,
            entityMetadata: { location: options.location.slice(0, 100) },
            description: this.buildEventDescription(options),
          });

          eventUrl = `https://discord.com/events/${interaction.guildId}/${event.id}`;
        }
      } catch (err) {
        this.logger.warn(`Event create failed (ok): ${err}`);
      }

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
          "RSVP buttons are pinned inside the thread.",
          "The thread panel + attendance list are pinned inside the thread.",
          "Organizer auto-added to Going.",
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

      // starter message of a thread is the PARENT message
      const starterMsg = await thread.fetchStarterMessage().catch(() => null);
      if (!starterMsg) {
        return interaction.editReply(
          "I couldn't find the parent meetup message for this thread (it may have been deleted).",
        );
      }

      // Get RSVP role id by reading the THREAD RSVP message buttons (or older parent buttons, if any)
      // Since we removed parent buttons, we infer roleId from the existing pinned RSVP-in-thread message
      const existingRoleId = await this.getRsvpRoleIdFromThread(thread);
      if (!existingRoleId) {
        return interaction.editReply("I couldn't find the RSVP role for this meetup thread.");
      }

      // Rename role to match new meetup details
      await this.tryRenameRsvpRole(interaction, existingRoleId, options).catch(() => null);

      const existingOrganizerId =
        getOrganizerIdFromPanelText(starterMsg.content ?? "") ?? interaction.user?.id ?? null;
      const trustedStatus = await this.getTrustedOrganizerStatus(interaction, existingOrganizerId);


      // Update parent message text (NO buttons), include thread link
      const newParentText = this.buildMeetupPanelText(
        options,
        startUnix,
        endUnix,
        existingRoleId,
        existingOrganizerId,
        trustedStatus,
        thread.url,
      );

      await starterMsg
        .edit({
          content: newParentText,
          components: [],
        })
        .catch(() => null);

      // Update pinned RSVP message inside thread (buttons message) — keep it short
      await this.upsertThreadRsvpMessage(
        thread,
        this.buildThreadRsvpText(options, startUnix, endUnix, existingOrganizerId, existingRoleId),
        existingRoleId,
      );

      await thread.setName(`[${options.county}] ${options.title}`.slice(0, 100));

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

      const roleId = await this.getRsvpRoleIdFromThread(thread);
      const canceller = `<@${interaction.user.id}>`;

      if (roleId) {
        await thread
          .send(
            [
              `<@&${roleId}>`,
              "❌ **This meetup has been canceled.**",
              `Canceled by: ${canceller}`,
              "[MEETUP_CANCELED]"
            ].join("\n"),
          )
          .catch(() => null);

        await this.deleteRsvpRoleById(interaction, roleId);
      } else {
        await thread
          .send(
            [
              "❌ **This meetup has been canceled.**",
              `Canceled by: ${canceller}`,
              "[MEETUP_CANCELED]"
            ].join("\n"))
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

  if (!ch || (ch.type !== ChannelType.PublicThread && ch.type !== ChannelType.PrivateThread)) {
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

    const roleId = await this.getRsvpRoleIdFromThread(thread);
    if (roleId) {
      await this.deleteRsvpRoleById(interaction, roleId);
    }

    await thread
      .send(
        [
          "✅ **This meetup has been marked as completed.**",
          `Closed by: ${interaction.user}`,
          `[MEETUP_COMPLETE]`,
        ].join("\n"),
      )
      .catch(() => null);

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

@Subcommand({
  name: "history",
  description: "Show completed meetups (run in #meetups)",
})
public async onHistory(
  @Context() [interaction]: SlashCommandContext,
  @Options() options: MeetupHistoryDto,
) {
  const allowedId = process.env.MEETUP_CHANNEL_ID!;
  const isMod = hasModRole(interaction);

  // Non-mods must run this in #meetups
  const gate = assertMeetupHistoryChannel(interaction);
  if (gate && !isMod) {
    return interaction.reply({ ephemeral: true, content: gate });
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    // Always scan the real #meetups channel, even if the command was run elsewhere (mods)
    const meetupsChannel = await interaction.guild?.channels.fetch(allowedId).catch(() => null);
    if (!meetupsChannel || meetupsChannel.type !== ChannelType.GuildText) {
      return interaction.editReply("Meetups channel is missing or not a text channel.");
    }

    const ch = meetupsChannel as TextChannel;

    // Fetch all archived threads under #meetups (public + private)
    const fetchAllArchived = async (type: "public" | "private") => {
      const out: ThreadChannel[] = [];
      let before: string | undefined = undefined;
      while (true) {
        const res = await ch.threads.fetchArchived({ type, limit: 100, before }).catch(() => null);
        if (!res) break;

        const threads = Array.from(res.threads.values()) as ThreadChannel[];
        out.push(...threads);

        if (threads.length < 100) break;
        before = threads[threads.length - 1]?.id;
        if (!before) break;
      }
      return out;
    };

    const [archivedPublic, archivedPrivate] = await Promise.all([
      fetchAllArchived("public"),
      fetchAllArchived("private"),
    ]);

    const allThreads = [...archivedPublic, ...archivedPrivate];

    // Find threads that contain the completion marker message
    const completed: Array<{ thread: ThreadChannel; completedAtMs: number }> = [];

    for (const t of allThreads) {
      // Safety: only consider threads that belong to the configured meetups channel
      if (t.parentId && t.parentId !== allowedId) continue;

      const msgs = await t.messages.fetch({ limit: 50 }).catch(() => null);
      if (!msgs) continue;

      const marker = msgs.find((m) => (m.content ?? "").includes("[MEETUP_COMPLETE]"));
      if (!marker) continue;

      completed.push({ thread: t, completedAtMs: marker.createdTimestamp });
    }

    if (completed.length === 0) {
      return interaction.editReply("No completed meetups yet.");
    }

    // Sort oldest -> newest so pages behave like you described (page 1 = oldest)
    completed.sort((a, b) => a.completedAtMs - b.completedAtMs);

    const pageSize = 10;
    const totalPages = Math.max(1, Math.ceil(completed.length / pageSize));
    const requested = options?.page ?? totalPages;
    const page = Math.min(Math.max(requested, 1), totalPages);

    const start = (page - 1) * pageSize;
    const slice = completed.slice(start, start + pageSize);

    const lines: string[] = [];
    lines.push(`**Meetup history (page ${page}/${totalPages})**`);
    lines.push(`Completed meetups: **${completed.length}**`);
    lines.push("");

    for (const item of slice) {
      const unix = Math.floor(item.completedAtMs / 1000);
      const link = `https://discord.com/channels/${interaction.guildId}/${item.thread.id}`;
      lines.push(`• <t:${unix}:D> — **${item.thread.name}** — ${link}`);
    }

    if (requested !== page) {
      lines.push("");
      lines.push(`Requested page ${requested} is out of range. Showing page ${page}.`);
    }

    return interaction.editReply(lines.join("\n"));
  } catch (err: any) {
    this.logger.error(`Meetup history failed: ${err}`);
    return interaction.editReply(err?.message ?? "History failed.");
  }
}

  // =========================
  // Permission helpers
  // =========================
  private async canManageMeetup(interaction: any, thread: ThreadChannel): Promise<boolean> {
    // Moderators (MOD_ID role) can manage any meetup.
    if (hasModRole(interaction)) return true;

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
      if (role.name !== newName) {
        await role
          .edit({ name: newName, mentionable: true }, "ScrubJay meetup edit: rename RSVP role")
          .catch(() => null);
      }
    } catch (e) {
      this.logger.warn(`RSVP role rename failed (ok): ${e}`);
    }
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
      // If click happened inside a thread, bi.channel IS the thread
      const ch = bi.channel;

      const thread: ThreadChannel | null =
        ch && (ch.type === ChannelType.PublicThread || ch.type === ChannelType.PrivateThread)
          ? (ch as ThreadChannel)
          : (((bi.message as any)?.thread as ThreadChannel | null) ?? null);

      if (!thread) return;
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

private async upsertAttendanceMessage(
  thread: ThreadChannel,
  _guildId: string,
  roleId: string,
) {
  const guild = thread.guild;
  if (!guild) return;

await guild.roles.fetch(roleId).catch(() => null);
await guild.members.fetch({ withPresences: false }).catch(() => null);

  const mentions = [...guild.members.cache.values()]
    .filter((m) => m.roles?.cache?.has(roleId))
    .sort((a, b) => (a.displayName ?? "").localeCompare(b.displayName ?? ""))
    .map((m) => `<@${m.id}>`);

  const existing = await this.findAttendanceMessage(thread);

// 🛡️ Safety: never overwrite a non-empty list with an empty one
if (existing && mentions.length === 0) {
  this.logger.warn(
    `[Attendance] computed 0 members for roleId=${roleId} in thread=${thread.id}. ` +
      `guildCache=${guild.members.cache.size}. Not overwriting existing list.`,
  );
  return;
}
  const content = this.buildAttendanceText(mentions);

  if (existing) {
    await existing.edit({ content }).catch(() => null);
    await existing.pin().catch(() => null);
    return;
  }

  const created = await thread.send({ content }).catch(() => null);
  if (created) await created.pin().catch(() => null);
}


  // =========================
  // Thread panel (pinned inside the thread)
  // =========================
  private async findThreadPanelMessage(thread: ThreadChannel): Promise<Message | null> {
    try {
      const pinned = await thread.messages.fetchPinned();
      const found = pinned.find((m) => (m.content ?? "").includes(THREAD_PANEL_TAG));
      if (found) return found;

      const recent = await thread.messages.fetch({ limit: 50 }).catch(() => null);
      const foundRecent = recent?.find((m) => (m.content ?? "").includes(THREAD_PANEL_TAG));
      return foundRecent ?? null;
    } catch {
      return null;
    }
  }

  private async upsertThreadPanelMessage(thread: ThreadChannel, content: string) {
    const existing = await this.findThreadPanelMessage(thread);
    if (existing) {
      await existing.edit({ content }).catch(() => null);
      await existing.pin().catch(() => null);
      return;
    }
    const created = await thread.send({ content }).catch(() => null);
    if (created) await created.pin().catch(() => null);
  }

  // =========================
  // Thread RSVP message (buttons inside the thread)
  // =========================
  private async findThreadRsvpMessage(thread: ThreadChannel, roleId: string): Promise<Message | null> {
    try {
      const isRsvpMessage = (m: Message) => {
        const comps: any[] = (m as any)?.components ?? [];
        for (const row of comps) {
          const rowComps: any[] = row?.components ?? [];
          for (const c of rowComps) {
            const parsed = parseRsvpCustomId(c?.customId ?? "");
            if (parsed?.roleId === roleId) return true;
          }
        }
        return false;
      };

      const pinned = await thread.messages.fetchPinned().catch(() => null);
      const foundPinned = pinned?.find((m) => isRsvpMessage(m));
      if (foundPinned) return foundPinned;

      const recent = await thread.messages.fetch({ limit: 50 }).catch(() => null);
      const foundRecent = recent?.find((m) => isRsvpMessage(m));
      return foundRecent ?? null;
    } catch {
      return null;
    }
  }

  private async upsertThreadRsvpMessage(thread: ThreadChannel, content: string, roleId: string) {
    const existing = await this.findThreadRsvpMessage(thread, roleId);

    if (existing) {
      await existing
        .edit({
          content,
          components: [buildRsvpRow(roleId)],
        })
        .catch(() => null);

      await existing.pin().catch(() => null);
      return;
    }

    const created = await thread
      .send({
        content,
        components: [buildRsvpRow(roleId)],
      })
      .catch(() => null);

    if (created) await created.pin().catch(() => null);
  }

private async getRsvpRoleIdFromThread(thread: ThreadChannel): Promise<string | null> {
  try {
    this.logger.debug(`[RSVP] Checking thread ${thread.id}`);

    // 1) PINS FIRST (new design)
    const pinsResp = await (thread.messages as any).fetchPins?.().catch((e: any) => {
      this.logger.debug(`[RSVP] Failed to fetch pins for ${thread.id}: ${e}`);
      return null;
    });

    // Some discord.js versions use fetchPinned() instead of fetchPins()
    const pinsResp2 =
      pinsResp ??
      (await (thread.messages as any).fetchPinned?.().catch((e: any) => {
        this.logger.debug(`[RSVP] Failed to fetch pinned for ${thread.id}: ${e}`);
        return null;
      }));

    const pinnedMessages = asMessageArray(pinsResp2);
    this.logger.debug(`[RSVP] Pinned messages in ${thread.id}: ${pinnedMessages.length}`);

    // 1a) Prefer RSVP buttons in pinned messages
    for (const m of pinnedMessages) {
      const roleId = getRoleIdFromMessageComponents(m);
      if (roleId) {
        this.logger.debug(`[RSVP] Found roleId ${roleId} in pinned buttons message ${m.id}`);
        return roleId;
      }
    }

    // 1b) Fallback: pinned THREAD_PANEL_TAG contains <@&ROLEID>
    for (const m of pinnedMessages) {
      const content = m?.content ?? "";
      if (content.includes("[SCRUBJAY_MEETUP_THREAD_PANEL]")) {
        const roleId = getRoleIdFromText(content);
        if (roleId) {
          this.logger.debug(`[RSVP] Found roleId ${roleId} in pinned THREAD_PANEL_TAG ${m.id}`);
          return roleId;
        }
      }
    }

    // 2) Fallback: starter message (old design had buttons on starter)
    const starter = await thread.fetchStarterMessage().catch(() => null);
    if (starter) {
      this.logger.debug(`[RSVP] Checking starter message in ${thread.id}`);

      const roleIdFromButtons = getRoleIdFromMessageComponents(starter);
      if (roleIdFromButtons) {
        this.logger.debug(`[RSVP] Found roleId ${roleIdFromButtons} in starter message`);
        return roleIdFromButtons;
      }

      const roleIdFromText = getRoleIdFromText(starter.content ?? "");
      if (roleIdFromText) {
        this.logger.debug(`[RSVP] Found roleId ${roleIdFromText} in starter text`);
        return roleIdFromText;
      }
    } else {
      this.logger.debug(`[RSVP] No starter message for ${thread.id}`);
    }

    // 3) Final fallback: recent messages
    const recent = await thread.messages.fetch({ limit: 50 }).catch(() => null);
    if (recent) {
      this.logger.debug(`[RSVP] Scanning recent messages in ${thread.id}`);

      for (const m of recent.values()) {
        const roleId = getRoleIdFromMessageComponents(m);
        if (roleId) {
          this.logger.debug(`[RSVP] Found roleId ${roleId} in recent message components`);
          return roleId;
        }
      }

      for (const m of recent.values()) {
        const roleId = getRoleIdFromText(m.content ?? "");
        if (roleId) {
          this.logger.debug(`[RSVP] Found roleId ${roleId} in recent message text`);
          return roleId;
        }
      }
    }

    this.logger.debug(`[RSVP] ❌ No RSVP roleId found for thread ${thread.id}`);
    return null;
  } catch (e) {
    this.logger.warn(
      `[RSVP] Error while resolving roleId for ${thread.id}: ${e}`,
    );
    return null;
  }
}


  private buildThreadPanelText(
    options: MeetupCreateDto,
    startUnix: number,
    endUnix: number | undefined,
    organizerId: string | null,
  ) {
    const lines: string[] = [];
    lines.push(`📌 **Meetup Panel** ${THREAD_PANEL_TAG}`);
    lines.push("");
    lines.push(`🗓️ **[${options.county}] ${options.title}**`);
    lines.push(
      `⏰ **When:** <t:${startUnix}:f>${endUnix ? ` – <t:${endUnix}:t>` : ""}  (<t:${startUnix}:R>)`,
    );
    lines.push(`📍 **Where:** ${options.location}`);
    if (options.notes) lines.push(`📝 **Notes:** ${options.notes}`);
    if (organizerId) lines.push(`🧑‍💼 **Organizer:** <@${organizerId}>`);
    lines.push("");
    lines.push("✅ RSVP using the **pinned buttons message** in this thread.");

    return lines.join("\n");
  }

  // =========================
  // Text builders
  // =========================
  private buildEventDescription(options: MeetupCreateDto) {
    const lines: string[] = [];
    lines.push("ScrubJay Meetup");
    if (options.notes) lines.push(`Notes: ${options.notes}`);
    lines.push("");
    lines.push("Safety: 18+ only. No personal info required. No DMs. Keep coordination in the thread.");
    return lines.join("\n").slice(0, 900);
  }

  // Parent message (meetup-board) — NO buttons, includes thread link once created
  private buildMeetupPanelText(
    options: MeetupCreateDto,
    startUnix: number,
    endUnix: number | undefined,
    rsvpRoleId: string | null,
    organizerId: string | null,
  isTrustedOrganizer: boolean | null,
    threadUrl: string | null,
  ) {
    const lines: string[] = [];

    lines.push(`🗓️ **[${options.county}] ${options.title}**`);
    lines.push(
      `⏰ **When:** <t:${startUnix}:f>${endUnix ? ` – <t:${endUnix}:t>` : ""}  (<t:${startUnix}:R>)`,
    );
    lines.push(`📍 **Where:** ${options.location}`);
    if (options.notes) lines.push(`📝 **Notes:** ${options.notes}`);

    if (organizerId) {
      lines.push(`🧑‍💼 **Organizer:** <@${organizerId}>`);
      if (isTrustedOrganizer === true) {
        lines.push(`☑️ Trusted Organizer`);
      } else if (isTrustedOrganizer === false) {
        lines.push(
          `ℹ️ This organizer isn’t marked as a Trusted Organizer yet. Please use normal meetup best practices.`,
        );
      }
      lines.push(`${ORGANIZER_TAG_PREFIX}${organizerId})`);
    }

    lines.push("");
    lines.push(`✅ **RSVP using the buttons inside the meetup thread: ${threadUrl}**`);

    return lines.join("\n");
  }

  // Thread RSVP message (buttons) — intentionally short to avoid repeating the parent message
  private buildThreadRsvpText(
    options: MeetupCreateDto,
    startUnix: number,
    endUnix: number | undefined,
    organizerId: string | null,
    rsvpRoleId: string | null,
  ) {
    const lines: string[] = [];

    //Tag
    lines.push(`[SCRUBJAY_MEETUP_THREAD_PANEL]`)
    lines.push("")

    lines.push(`✅ **RSVP for:** **[${options.county}] ${options.title}**`);
    lines.push(
      `⏰ <t:${startUnix}:f>${endUnix ? ` – <t:${endUnix}:t>` : ""}  •  (<t:${startUnix}:R>)`,
    );
    lines.push(`📍 ${options.location}`);
    if (organizerId) lines.push(`🧑‍💼 Organizer: <@${organizerId}>`);
    if (rsvpRoleId) lines.push(`🔔 Ping role: <@&${rsvpRoleId}>`);
    lines.push("");
    lines.push("👇 **Use the buttons below to RSVP**");

    return lines.join("\n");
  }

// =========================
// Startup sync (refresh attendance after deploy)
// =========================
@On("ready")
public async onReady([client]: [any]) {
  try {
    this.logger.log("Meetup startup: rebuilding board cache…");
    await this.board.rebuildFromDiscord(client);

    const meetups = this.board.getAll();
    this.logger.log(`Meetup startup: syncing attendance for ${meetups.length} meetups…`);

    for (const m of meetups) {
      if (!m?.threadId) continue;
      if (m.status === "CANCELED" || m.status === "CLOSED") continue;

      const ch = await client.channels.fetch(m.threadId).catch(() => null);
      if (!ch) continue;

      if (ch.type !== ChannelType.PublicThread && ch.type !== ChannelType.PrivateThread) continue;
      const thread = ch as ThreadChannel;

      if (thread.archived && thread.locked) continue;

      const roleId = await this.getRsvpRoleIdFromThread(thread).catch(() => null);
      if (!roleId) continue;

      // 🔑 REQUIRED: hydrate member cache so role.members works
      await thread.guild.members.fetch().catch(() => null);

      await this.upsertAttendanceMessage(thread, m.guildId, roleId).catch(() => null);

      // micro-throttle: avoid burst requests at startup
      await new Promise((r) => setTimeout(r, 200));
    }

    this.logger.log("Meetup startup: attendance sync complete.");
  } catch (e) {
    this.logger.warn(`Startup attendance sync failed (ok): ${e}`);
  }
}


  @Subcommand({
    name: "help",
    description: "Learn how meetups work",
  })
  public async onHelp(
    @Context() [interaction]: SlashCommandContext,
  ) {
    const allowedId = process.env.MEETUP_CHANNEL_ID!;
    const ch = interaction.channel;

    if (!ch || ch.id !== allowedId) {
      return interaction.reply({
        ephemeral: true,
        content: "Run this command in the meetups channel.",
      });
    }

    return interaction.reply({
      ephemeral: true,
      content: MEETUP_HELP_TEXT,
    });
  }
}
