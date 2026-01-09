import { Injectable, Logger } from "@nestjs/common";
import {
  ChannelType,
  Client,
  TextChannel,
  type Message,
  type ThreadChannel,
} from "discord.js";

export type MeetupStatus = "SCHEDULED" | "CANCELED" | "CLOSED";

export type StoredMeetup = {
  id: string;
  guildId: string;
  creatorId: string;
  title: string;
  location: string;
  startUnix: number;
  threadId: string;
  threadUrl: string;
  eventUrl?: string;
  status: MeetupStatus;
};

const BOARD_HEADER = "📌 Ongoing Meetup Threads";
const BOARD_TAG = "[SCRUBJAY_MEETUP_BOARD]";

function cfg() {
  return {
    meetupChannelId: process.env.MEETUP_CHANNEL_ID,
    boardChannelId: process.env.MEETUP_BOARD_CHANNEL_ID,
  };
}

@Injectable()
export class MeetupBoardService {
  private readonly logger = new Logger(MeetupBoardService.name);

  // In-memory store (rebuilt from Discord on boot)
  private meetupsById = new Map<string, StoredMeetup>();
  private meetupIdByThreadId = new Map<string, string>();

  public upsert(meetup: StoredMeetup) {
    this.meetupsById.set(meetup.id, meetup);
    this.meetupIdByThreadId.set(meetup.threadId, meetup.id);
  }

  public getByThreadId(threadId: string): StoredMeetup | undefined {
    const id = this.meetupIdByThreadId.get(threadId);
    if (!id) return undefined;
    return this.meetupsById.get(id);
  }

  public setStatus(id: string, status: MeetupStatus) {
    const m = this.meetupsById.get(id);
    if (!m) return;
    m.status = status;
    this.meetupsById.set(id, m);
  }

  /**
   * Rebuild memory by scanning threads under MEETUP_CHANNEL_ID.
   * Source of truth = pinned meetup panel message (the one with RSVP buttons).
   *
   * Call this ONCE on boot (via @On("ready")).
   */
  public async rebuildFromDiscord(client: Client) {
    const { meetupChannelId } = cfg();

    if (!meetupChannelId) {
      throw new Error("MEETUP_CHANNEL_ID is missing.");
    }

    const ch = await client.channels.fetch(meetupChannelId);
    if (!ch || ch.type !== ChannelType.GuildText) {
      throw new Error("MEETUP_CHANNEL_ID is not a guild text channel.");
    }
    const parent = ch as TextChannel;

    // Reset memory
    this.meetupsById.clear();
    this.meetupIdByThreadId.clear();

    // Active threads under the parent channel
    const active = await parent.threads.fetchActive();

    // (Optional) include archived public threads so you can recover if Discord auto-archives
    let archivedThreads: ThreadChannel[] = [];
    try {
      const archivedPublic = await parent.threads.fetchArchived({ type: "public" });
      archivedThreads = [...archivedPublic.threads.values()];
    } catch (e) {
      this.logger.warn(`Could not fetch archived threads: ${e}`);
    }

    const threads = [...active.threads.values(), ...archivedThreads];

    // Deduplicate by id
    const seen = new Set<string>();
    const uniqueThreads: ThreadChannel[] = [];
    for (const t of threads) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      uniqueThreads.push(t);
    }

    for (const thread of uniqueThreads) {
      // Skip ended threads (your cancel/close locks+archives)
      if (thread.archived && thread.locked) continue;

      const panel = await this.findPinnedMeetupPanel(thread);
      if (!panel) continue;

      const parsed = this.parsePanelText(panel.content ?? "");

      const title = parsed.title ?? thread.name ?? "Meetup";
      const location = parsed.location ?? "—";
      const startUnix = parsed.startUnix ?? 0;

      const guildId = thread.guild?.id;
      if (!guildId) continue;

      const creatorId = (thread as any).ownerId ?? "unknown";

      // Use thread id as meetup id (stable across redeploys)
      const meetupId = thread.id;

      this.upsert({
        id: meetupId,
        guildId,
        creatorId,
        title,
        location,
        startUnix,
        threadId: thread.id,
        threadUrl: thread.url,
        eventUrl: undefined,
        status: "SCHEDULED",
      });
    }

    this.logger.log(`Rebuilt meetups from Discord: ${this.meetupsById.size}`);
  }

  /**
   * Render board using CURRENT in-memory meetups.
   * (We do NOT rebuild here; that happens once on boot.)
   */
  public async renderToBoard(client: Client) {
    const { boardChannelId, meetupChannelId } = cfg();

    const channelId = boardChannelId ?? meetupChannelId;
    if (!channelId) {
      throw new Error("MEETUP_BOARD_CHANNEL_ID (or MEETUP_CHANNEL_ID fallback) is missing.");
    }

    const ch = await client.channels.fetch(channelId);
    if (!ch || ch.type !== ChannelType.GuildText) {
      throw new Error("Board channel is not a guild text channel.");
    }

    const channel = ch as TextChannel;
    const boardMsg = await this.findOrCreateBoardMessage(channel);
    const content = this.buildBoardText();

    await boardMsg.edit({ content });
  }

  private listOngoingThreads(): StoredMeetup[] {
    // Optional filter so it doesn’t grow forever
    const now = Math.floor(Date.now() / 1000);
    const maxAgeDays = 14;
    const minUnix = now - maxAgeDays * 24 * 60 * 60;

    return [...this.meetupsById.values()]
      .filter((m) => m.status === "SCHEDULED" && (m.startUnix === 0 || m.startUnix >= minUnix))
      .sort((a, b) => {
        if (a.startUnix && b.startUnix) return a.startUnix - b.startUnix;
        if (a.startUnix && !b.startUnix) return -1;
        if (!a.startUnix && b.startUnix) return 1;
        return a.title.localeCompare(b.title);
      });
  }

  private buildBoardText() {
    const ongoing = this.listOngoingThreads();

    const lines: string[] = [];
    lines.push(`${BOARD_HEADER} ${BOARD_TAG}`);
    lines.push("");

    if (!ongoing.length) {
      lines.push("• (No ongoing meetup threads)");
      return lines.join("\n");
    }

    for (const m of ongoing) {
      const when = m.startUnix ? `<t:${m.startUnix}:f>` : "(time unknown)";
      lines.push(`• ${when} — ${m.title} (${m.location})`);
      lines.push(`  [Open thread](${m.threadUrl})`);
      lines.push("");
    }

    return lines.join("\n").trimEnd();
  }

  private async findOrCreateBoardMessage(channel: TextChannel): Promise<Message> {
    const pinned = await channel.messages.fetchPinned();
    const existing = pinned.find((m) => m.content.includes(BOARD_TAG));
    if (existing) return existing;

    const msg = await channel.send({
      content: `${BOARD_HEADER} ${BOARD_TAG}\n\n• (No ongoing meetup threads)`,
    });
    await msg.pin();
    return msg;
  }

  // =========================
  // Panel detection + parsing
  // =========================

  private async findPinnedMeetupPanel(thread: ThreadChannel): Promise<Message | null> {
    try {
      const pinned = await thread.messages.fetchPinned();

      // pinned message that has RSVP buttons (customId starts with meetup_rsvp:)
      const panel = pinned.find((m) => this.messageHasRsvpButtons(m));
      return panel ?? null;
    } catch {
      return null;
    }
  }

  private messageHasRsvpButtons(msg: Message): boolean {
    try {
      const rows = (msg as any).components ?? [];
      for (const row of rows) {
        const comps = row?.components ?? [];
        for (const c of comps) {
          const id = c?.customId ?? "";
          if (typeof id === "string" && id.startsWith("meetup_rsvp:")) return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  private parsePanelText(text: string): { title?: string; location?: string; startUnix?: number } {
    const out: { title?: string; location?: string; startUnix?: number } = {};

    // Title line: 🗓️ **Title**
    const titleMatch = text.match(/🗓️\s*\*\*(.+?)\*\*/);
    if (titleMatch?.[1]) out.title = titleMatch[1].trim();

    // Location line: 📍 **Where:** <location>
    const locMatch = text.match(/📍\s*\*\*Where:\*\*\s*(.+)/);
    if (locMatch?.[1]) out.location = locMatch[1].trim();

    // Start time: first <t:UNIX:f>
    const timeMatch = text.match(/<t:(\d+):f>/);
    if (timeMatch?.[1]) out.startUnix = Number(timeMatch[1]);

    return out;
  }
}
