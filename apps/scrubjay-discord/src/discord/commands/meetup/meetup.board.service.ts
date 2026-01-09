import { Injectable, Logger } from "@nestjs/common";
import {
  ChannelType,
  Client,
  TextChannel,
  type Message,
} from "discord.js";
import { sandboxConfig } from "./meetup.sandbox";

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

const BOARD_HEADER = "📌 Upcoming Meetups";
const BOARD_TAG = "[SCRUBJAY_MEETUP_BOARD]";

@Injectable()
export class MeetupBoardService {
  private readonly logger = new Logger(MeetupBoardService.name);

  // Sandbox MVP: in-memory store (swap to DB later)
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

  private listUpcoming(): StoredMeetup[] {
    const now = Math.floor(Date.now() / 1000);
    return [...this.meetupsById.values()]
      .filter((m) => m.status === "SCHEDULED" && m.startUnix >= now - 6 * 60 * 60)
      .sort((a, b) => a.startUnix - b.startUnix);
  }

  public async renderToBoard(client: Client) {
    const cfg = sandboxConfig();

    const boardChannelId = cfg.boardChannelId ?? cfg.channelId;
    if (!boardChannelId) {
      throw new Error(
        "Sandbox board channel id is missing. Set MEETUP_SANDBOX_BOARD_CHANNEL_ID or MEETUP_SANDBOX_CHANNEL_ID.",
      );
    }

    const ch = await client.channels.fetch(boardChannelId);
    if (!ch || ch.type !== ChannelType.GuildText) {
      throw new Error("Board channel is not a guild text channel.");
    }

    const channel = ch as TextChannel;
    const boardMsg = await this.findOrCreateBoardMessage(channel);
    const content = this.buildBoardText();

    await boardMsg.edit({ content });
  }

  private buildBoardText() {
    const upcoming = this.listUpcoming();

    const lines: string[] = [];
    lines.push(`${BOARD_HEADER} ${BOARD_TAG}`);
    lines.push("");

    if (!upcoming.length) {
      lines.push("• (No upcoming meetups)");
      return lines.join("\n");
    }

    for (const m of upcoming) {
      const when = `<t:${m.startUnix}:f>`;
      const links: string[] = [];
      if (m.threadUrl) links.push(`[Thread](${m.threadUrl})`);
      if (m.eventUrl) links.push(`[Event](${m.eventUrl})`);

      lines.push(`• ${when} — ${m.title} (${m.location})`);
      lines.push(links.length ? `  ${links.join(" • ")}` : "  ");
      lines.push("");
    }

    return lines.join("\n").trimEnd();
  }

  private async findOrCreateBoardMessage(channel: TextChannel): Promise<Message> {
    const pinned = await channel.messages.fetchPinned();
    const existing = pinned.find((m) => m.content.includes(BOARD_TAG));
    if (existing) return existing;

    const msg = await channel.send({
      content: `${BOARD_HEADER} ${BOARD_TAG}\n\n• (No upcoming meetups)`,
    });
    await msg.pin();
    return msg;
  }
}
