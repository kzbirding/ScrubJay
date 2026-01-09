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

// ✅ Your meetup-board channel (continuously edited)
const MEETUP_BOARD_CHANNEL_ID = "1459069553727508610";

// ✅ The parent channel where meetups are created (threads live under this)
// Set this env var to the channel where you run /meetup create
// Example: MEETUP_CHANNEL_ID="123..."
function meetupChannelId() {
  const v = process.env.MEETUP_CHANNEL_ID;
  if (!v) throw new Error("MEETUP_CHANNEL_ID is missing.");
  return v;
}

@Injectable()
export class MeetupBoardService {
  private readonly logger = new Logger(MeetupBoardService.name);

  // In-memory store (rebuilt from Discord)
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
   * Rebuild memory by scanning threads under the configured meetup channel.
   * Source of truth = the THREAD STARTER MESSAGE (in the parent channel),
   * which contains the meetup panel + RSVP buttons.
   */
  public async rebuildFromDiscord(client: Client) {
    const meetupParentId = meetupChannelId();

    const ch = await client.channels.fetch(meetupParentId);
    if (!ch || ch.type !== ChannelType.GuildText) {
      throw new Error("Meetup channel is not a guild text channel.");
    }
    const parent = ch as TextChannel;

    // Reset memory
    this.meetupsById.clear();
    this.meetupIdByThreadId.clear();

    const active = await parent.threads.fetchActive();

    let archivedThreads: ThreadChannel[] = [];
    try {
      const archivedPublic = await parent.threads.fetchArchived({ type: "public" });
      archivedThreads = [...archivedPublic.threads.values()];
    } catch (e) {
      // missing perms is ok; we still handle active
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
      // Skip ended threads (cancel/close locks+archives)
      if (thread.archived && thread.locked) continue;

      const starterMsg = await thread.fetchStarterMessage().catch(() => null);
      if (!starterMsg) continue;

      // Only treat threads created by our system as meetups (must have RSVP buttons)
      if (!this.messageHasRsvpButtons(starterMsg)) continue;

      const parsed = this.parsePanelText(starterMsg.content ?? "");
      const title = parsed.title ?? thread.name ?? "Meetup";
      const location = parsed.location ?? "—";
      const startUnix = parsed.startUnix ?? 0;

      const guildId = thread.guild?.id;
      if (!guildId) continue;

      const creatorId = (thread as any).ownerId ?? "unknown";

      // Use threadId as meetup id (stable across redeploys)
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

  public async renderToBoard(client: Client) {
    await this.rebuildFromDiscord(client);

    const ch = await client.channels.fetch(MEETUP_BOARD_CHANNEL_ID);
    if (!ch || ch.type !== ChannelType.GuildText) {
      throw new Error("Board channel is not a guild text channel.");
    }

    const channel = ch as TextChannel;
    const boardMsg = await this.findOrCreateBoardMessage(channel);
    const content = this.buildBoardText();

    await boardMsg.edit({ content });
  }

  private listOngoingThreads(): StoredMeetup[] {
    // Optional: prevent board from growing forever
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
      lines.push(`  ${m.threadUrl}`);
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
    await msg.pin().catch(() => null);
    return msg;
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

    const titleMatch = text.match(/🗓️\s*\*\*(.+?)\*\*/);
    if (titleMatch?.[1]) out.title = titleMatch[1].trim();

    const locMatch = text.match(/📍\s*\*\*Where:\*\*\s*(.+)/);
    if (locMatch?.[1]) out.location = locMatch[1].trim();

    const timeMatch = text.match(/<t:(\d+):f>/);
    if (timeMatch?.[1]) out.startUnix = Number(timeMatch[1]);

    return out;
  }
}
