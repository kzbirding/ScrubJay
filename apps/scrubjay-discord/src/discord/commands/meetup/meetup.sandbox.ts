import { ChannelType, type ChatInputCommandInteraction } from "discord.js";

function envBool(v?: string) {
  return (v ?? "").toLowerCase() === "true";
}

export function isSandboxMode() {
  return envBool(process.env.MEETUP_SANDBOX_MODE);
}

export function sandboxConfig() {
  return {
    guildId: process.env.MEETUP_SANDBOX_GUILD_ID,
    channelId: process.env.MEETUP_SANDBOX_CHANNEL_ID,
    boardChannelId:
      process.env.MEETUP_SANDBOX_BOARD_CHANNEL_ID ??
      process.env.MEETUP_SANDBOX_CHANNEL_ID,
  };
}

export function assertSandboxAllowed(i: ChatInputCommandInteraction) {
  if (!isSandboxMode()) return { ok: true as const };

  const { guildId, channelId } = sandboxConfig();

  // Must be in the sandbox guild
  if (!i.guildId || i.guildId !== guildId) {
    return {
      ok: false as const,
      reason: `Sandbox mode is ON. This command only works in the sandbox guild (${guildId}).`,
    };
  }

  const ch = i.channel;
  if (!ch) {
    return {
      ok: false as const,
      reason: "Sandbox mode: channel not found.",
    };
  }

  // Allowed directly in #bot-sandbox
  if (i.channelId === channelId) {
    return { ok: true as const };
  }

  // Allowed in threads under #bot-sandbox
  if (
    ch.type === ChannelType.PublicThread ||
    ch.type === ChannelType.PrivateThread
  ) {
    const parentId = (ch as any).parentId as string | null | undefined;
    if (parentId === channelId) {
      return { ok: true as const };
    }
  }

  return {
    ok: false as const,
    reason: `Sandbox mode is ON. Use this command in <#${channelId}> or its meetup threads.`,
  };
}
