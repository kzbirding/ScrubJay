import { Injectable, Logger } from "@nestjs/common";
import {
  ChannelType,
  Client,
  TextChannel,
  type Message,
} from "discord.js";
import { sandboxConfig } from "./meetup.sandbox";

type BoardMeetup = {
  id: string;
  title: string;
  location: string;
  startUnix: number;
  threadUrl?: string;
  eventUrl?: string;
  status: "SCHEDULED" | "CANCELED" | "CLOSED";
};

const BOARD_HEADER = "📌 Upcoming Meetups";
const BOARD_TAG = "[SCRUBJAY_MEETUP_BOARD]";

@Injectable()
export class MeetupBoardService {
  private readonly logger = new Logger(MeetupBoardService.name);

  // Sandbox MVP: in-memory store (we’ll swap to DB later)
  private meetups = new Map<string, BoardMeetup>();

  public upsert(meetup: BoardMeetup) {
    this.meetups.set(meetup.id, meetup);
  }

  public remove(id: string) {
    this.meetups.delete(id);
  }

  private listUpcoming(): BoardMeetup[] {
    const now = Math.floor(Date.now() / 1000);
    return [...this.meetups.values()]
      // show upcoming, plus allow a small past buffer so it doesn’t vanish instantly
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
