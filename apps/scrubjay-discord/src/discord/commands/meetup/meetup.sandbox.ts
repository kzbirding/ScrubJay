import type { ChatInputCommandInteraction } from "discord.js";

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

  if (!i.guildId || i.guildId !== guildId) {
    return {
      ok: false as const,
      reason: `Sandbox mode is ON. This command only works in the sandbox guild (${guildId}).`,
    };
  }

  if (!i.channelId || i.channelId !== channelId) {
    return {
      ok: false as const,
      reason: `Sandbox mode is ON. Use this command only in <#${channelId}>.`,
    };
  }

  return { ok: true as const };
}
