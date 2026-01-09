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

// These are the pinned-message tags inside meetup threads
const THREAD_PANEL_TAG = "[SCRUBJAY_MEETUP_THREAD_PANEL]";
const ATTENDANCE_TAG = "[SCRUBJAY_MEETUP_ATTENDANCE]";

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
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

  public getAll(): StoredMeetup[] {
    return [...this.meetupsById.values()];
  }

  /**
   * Rebuild memory by scanning threads under the configured MEETUP_CHANNEL_ID.
   * Source of truth = pinned ScrubJay tags inside the thread (panel/attendance).
   *
   * Note: thread starter message is the parent-channel message (no buttons now),
   * but it still contains the structured panel text used for parsing.
   */
  public async rebuildFromDiscord(client: Client) {
    const meetupChannelId = reqEnv("MEETUP_CHANNEL_ID");

    const ch = await client.channels.fetch(meetupChannelId);
    if (!ch || ch.type !== ChannelType.GuildText) {
      throw new Error("MEETUP_CHANNEL_ID is not a guild text channel.");
    }
    const parent = ch as TextChannel;

    // Reset memory
    this.meetupsById.clear();
    this.meetupIdByThreadId.clear();

    // Active threads
    const active = await parent.threads.fetchActive();

    // Recently archived threads (helps recover if auto-archived)
    let archivedThreads: ThreadChannel[] = [];
    try {
      const archivedPublic = await parent.threads.fetchArchived({ type: "public" });
      archivedThreads = [...archivedPublic.threads.values()];
    } catch (e) {
      this.logger.warn(`Could not fetch archived threads (ok): ${e}`);
    }

    const threads = [...active.threads.values(), ...archivedThreads];

    // Deduplicate
    const seen = new Set<string>();
    const unique: ThreadChannel[] = [];
    for (const t of threads) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      unique.push(t);
    }

    for (const thread of unique) {
      // Skip ended threads (your cancel/close locks+archives)
      if (thread.archived && thread.locked) continue;

      // ✅ Identify meetups by pinned ScrubJay tags (cheapest, never misses)
      const isMeetup = await this.threadHasScrubJayPins(thread);
      if (!isMeetup) continue;

      // Starter message is the parent message. It may exist and contains details.
      const starterMsg = await thread.fetchStarterMessage().catch(() => null);

      // Parse details from starter message if available; fallback to thread name.
      const parsed = this.parsePanelText(starterMsg?.content ?? "");
      const title = parsed.title ?? thread.name ?? "Meetup";
      const location = parsed.location ?? "—";
      const startUnix = parsed.startUnix ?? 0;

      const guildId = thread.guild?.id;
      if (!guildId) continue;

      const creatorId = (thread as any).ownerId ?? "unknown";

      // Use threadId as stable meetup ID
      this.upsert({
        id: thread.id,
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
  }

  public async renderToBoard(client: Client) {
    // Rebuild first (survives redeploys)
    await this.rebuildFromDiscord(client);

    const boardChannelId = reqEnv("MEETUP_BOARD_CHANNEL_ID");
    const boardMessageId = reqEnv("MEETUP_BOARD_MESSAGE_ID");

    const ch = await client.channels.fetch(boardChannelId);
    if (!ch || ch.type !== ChannelType.GuildText) {
      throw new Error("MEETUP_BOARD_CHANNEL_ID is not a guild text channel.");
    }
    const channel = ch as TextChannel;

    // ✅ Always edit THIS exact message ID (stable across redeploys)
    const boardMsg = await channel.messages.fetch(boardMessageId).catch(() => null);
    if (!boardMsg) {
      throw new Error(
        "Could not fetch MEETUP_BOARD_MESSAGE_ID in MEETUP_BOARD_CHANNEL_ID. " +
          "Check that the message ID is correct and the bot has Read Message History.",
      );
    }

    const content = this.buildBoardText();
    await boardMsg.edit({ content });
  }

  private listOngoingThreads(): StoredMeetup[] {
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

  // ✅ Only pinned messages; tags are guaranteed for every meetup thread
  private async threadHasScrubJayPins(thread: ThreadChannel): Promise<boolean> {
    try {
      const pinned = await thread.messages.fetchPinned().catch(() => null);
      if (!pinned) return false;

      for (const m of pinned.values()) {
        const content = m.content ?? "";
        if (content.includes(THREAD_PANEL_TAG)) return true;
        if (content.includes(ATTENDANCE_TAG)) return true;

        // optional extra safety: if pinned RSVP buttons message exists, accept too
        if (this.messageHasRsvpButtons(m as any)) return true;
      }

      return false;
    } catch {
      return false;
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

    const titleMatch = text.match(/🗓️\s*\*\*(.+?)\*\*/);
    if (titleMatch?.[1]) out.title = titleMatch[1].trim();

    const locMatch = text.match(/📍\s*\*\*Where:\*\*\s*(.+)/);
    if (locMatch?.[1]) out.location = locMatch[1].trim();

    const timeMatch = text.match(/<t:(\d+):f>/);
    if (timeMatch?.[1]) out.startUnix = Number(timeMatch[1]);

    return out;
  }
}
