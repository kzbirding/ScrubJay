import type { ChatInputCommandInteraction } from "discord.js";

function envBool(v?: string) {
  return (v ?? "").toLowerCase() === "true";
}

// Kept for later — currently unused
export function isSandboxMode() {
  return envBool(process.env.MEETUP_SANDBOX_MODE);
}

// Kept for later — currently unused
export function sandboxConfig() {
  return {
    guildId: process.env.MEETUP_SANDBOX_GUILD_ID,
    channelId: process.env.MEETUP_SANDBOX_CHANNEL_ID,
    boardChannelId:
      process.env.MEETUP_SANDBOX_BOARD_CHANNEL_ID ??
      process.env.MEETUP_SANDBOX_CHANNEL_ID,
  };
}

// ✅ TEMPORARY: allow meetup commands everywhere
export function assertSandboxAllowed(_i: ChatInputCommandInteraction) {
  return { ok: true as const };
}
