import { Injectable } from "@nestjs/common";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type ButtonInteraction,
} from "discord.js";
import {
  Context,
  On,
  Options,
  SlashCommand,
  StringOption,
  Subcommand,
  type ContextOf,
  type SlashCommandContext,
} from "necord";
import { QuizService } from "../q/q.service";
import { STANDARD_POOL } from "./standard.pool";
import { EXPANDED_POOL } from "./expanded.pool";

// ---- per-user difficulty (resets on restart) ----
type Difficulty = "easy" | "normal";
const USER_DIFFICULTY = new Map<string, Difficulty>();

type PoolName = "standard" | "expanded";
const USER_POOL = new Map<string, PoolName>();

const POOLS: Record<PoolName, readonly string[]> = {
  standard: STANDARD_POOL,
  expanded: EXPANDED_POOL,
};

// ---- per-user active quiz state (resets on restart) ----
type ActiveQuiz = {
  channelId: string;
  messageId: string;
  correctCode: string;
  correctName: string;
  correctSlug: string;
  difficulty: Difficulty;
  pool: PoolName;
  // if set, this quiz used buttons
  easyMessageId?: string;
};
const ACTIVE_QUIZ = new Map<string, ActiveQuiz>(); // userId -> quiz

function slugify(s: string): string {
  return (s || "")
    .toLowerCase()
    .trim()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// --- fuzzy matching helpers for /qa ---
function levenshtein(a: string, b: string): number {
  const A = slugify(a);
  const B = slugify(b);

  const m = A.length;
  const n = B.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = A[i - 1] === B[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }

  return dp[m][n];
}

function similarity(a: string, b: string): number {
  const A = slugify(a);
  const B = slugify(b);
  const denom = Math.max(A.length, B.length);
  if (denom === 0) return 0;
  return 1 - levenshtein(a, b) / denom;
}

// ----- DTOs -----
class PoolDto {
  @StringOption({
    name: "name",
    description: "Choose which bird pool to quiz from (saved for you)",
    required: true,
    choices: [
      { name: "standard", value: "standard" },
      { name: "expanded", value: "expanded" },
    ],
  })
  name!: PoolName;
}

class QaDto {
  @StringOption({
    name: "guess",
    description: "Your guess (common name)",
    required: true,
  })
  guess!: string;
}

/**
 * /q parent command + subcommands
 * IMPORTANT: class-level SlashCommand is required for Necord subcommands.
 */
@SlashCommand({
  name: "q",
  description: "Bird quiz",
})
@Injectable()
export class QCommand {
  constructor(private readonly quiz: QuizService) {}

  // ---------------- /q help ----------------
  @Subcommand({ name: "help", description: "Show quiz help" })
  public async help(@Context() [interaction]: SlashCommandContext) {
    return interaction.reply({
      ephemeral: true,
      content:
        "**/q start** → new quiz image\n" +
        "**/q easy** → buttons mode (saved for you)\n" +
        "**/q normal** → free-response mode (saved for you)\n" +
        "**/qa guess:<species>** → answer (normal; fuzzy)\n" +
        "**/q pool name:<standard|expanded>** → choose bird pool (saved for you)\n" +
        "**/q photo** → another photo of current bird\n" +
        "**/q hint** → first letter (normal only)\n" +
        "**/q skip** → reveal answer + new image\n" +
        "**/q end** → reveal answer + stop\n",
    });
  }

  // ---------------- /q easy ----------------
  @Subcommand({ name: "easy", description: "Enable easy mode (buttons)" })
  public async easy(@Context() [interaction]: SlashCommandContext) {
    USER_DIFFICULTY.set(interaction.user.id, "easy");
    return interaction.reply({ ephemeral: true, content: "✅ Easy mode enabled (buttons)." });
  }

  // ---------------- /q normal ----------------
@Subcommand({ name: "normal", description: "Enable normal mode (free response)" })
public async normal(@Context() [interaction]: SlashCommandContext) {
  const userId = interaction.user.id;
  const channelId = interaction.channelId;

  USER_DIFFICULTY.set(userId, "normal");

  // ✅ If there's an active quiz in this channel and it's currently easy-mode,
  // convert it immediately (remove buttons + allow /qa).
  const st = ACTIVE_QUIZ.get(userId);
  if (st && st.channelId === channelId && st.easyMessageId) {
    // update state: normal mode, no easyMessageId
    const next: ActiveQuiz = { ...st, difficulty: "normal" };
    delete (next as any).easyMessageId;
    ACTIVE_QUIZ.set(userId, next);

    // try to remove buttons from the existing message so user can /qa right away
    const ch: any = interaction.channel;
    const msg = await ch?.messages?.fetch?.(st.messageId).catch(() => null);
    if (msg) await msg.edit({ components: [] }).catch(() => null);
  }

  return interaction.reply({
    ephemeral: true,
    content: "✅ Normal mode enabled (free response).",
  });
}


  // ---------------- /q pool ----------------
  @Subcommand({ name: "pool", description: "Choose which bird pool you quiz from" })
  public async pool(
    @Context() [interaction]: SlashCommandContext,
    @Options() options: PoolDto,
  ) {
    USER_POOL.set(interaction.user.id, options.name);
    return interaction.reply({ ephemeral: true, content: `✅ Pool set to **${options.name}**.` });
  }

  // ---------------- /q start ----------------
  @Subcommand({ name: "start", description: "Start (or continue) your quiz" })
  public async start(@Context() [interaction]: SlashCommandContext) {
    const userId = interaction.user.id;
    const channelId = interaction.channelId;

    const st = ACTIVE_QUIZ.get(userId);
    if (st && st.channelId === channelId) {
      return interaction.reply({
        ephemeral: true,
        content:
          "You already have an active quiz here.\n" +
          "Use **/qa** (normal), **/q photo**, **/q hint**, **/q skip**, or **/q end**.",
      });
    }

    return this.sendQuiz(interaction, userId, channelId);
  }

  // ---------------- /q hint ----------------
  @Subcommand({ name: "hint", description: "Show the first letter (normal only)" })
  public async hint(@Context() [interaction]: SlashCommandContext) {
    const userId = interaction.user.id;
    const channelId = interaction.channelId;

    const st = ACTIVE_QUIZ.get(userId);
    if (!st || st.channelId !== channelId) {
      return interaction.reply({ ephemeral: true, content: "No active quiz here. Use **/q start**." });
    }
    if (st.difficulty !== "normal" || st.easyMessageId) {
      return interaction.reply({ ephemeral: true, content: "Hints are only available in **normal mode**." });
    }

    return interaction.reply({
      ephemeral: true,
      content: `💡 Starts with **${st.correctName[0].toUpperCase()}**`,
    });
  }

  // ---------------- /q photo ----------------
  @Subcommand({ name: "photo", description: "Get another photo of the current species" })
  public async photo(@Context() [interaction]: SlashCommandContext) {
    const userId = interaction.user.id;
    const channelId = interaction.channelId;

    const st = ACTIVE_QUIZ.get(userId);
    if (!st || st.channelId !== channelId) {
      return interaction.reply({ ephemeral: true, content: "No active quiz here. Use **/q start**." });
    }

    await interaction.reply({ ephemeral: true, content: "📸 Getting another photo..." });
    return this.sendAnotherPhoto(interaction, userId, st);
  }

  // ---------------- /q skip ----------------
  @Subcommand({ name: "skip", description: "Reveal answer and immediately show a new question" })
  public async skip(@Context() [interaction]: SlashCommandContext) {
    const userId = interaction.user.id;
    const channelId = interaction.channelId;

    const st = ACTIVE_QUIZ.get(userId);
    if (!st || st.channelId !== channelId) {
      return interaction.reply({ ephemeral: true, content: "No active quiz here. Use **/q start**." });
    }

    await interaction.reply({ ephemeral: false, content: `⏭️ Skipped. Answer: **${st.correctName}**` });
    ACTIVE_QUIZ.delete(userId);

    return this.sendQuiz(interaction, userId, channelId);
  }

  // ---------------- /q end ----------------
  @Subcommand({ name: "end", description: "Reveal answer and end the current question" })
  public async end(@Context() [interaction]: SlashCommandContext) {
    const userId = interaction.user.id;
    const channelId = interaction.channelId;

    const st = ACTIVE_QUIZ.get(userId);
    if (!st || st.channelId !== channelId) {
      return interaction.reply({ ephemeral: true, content: "No active quiz here. Use **/q start**." });
    }

    await interaction.reply({ ephemeral: false, content: `🛑 Ended. Answer: **${st.correctName}**` });
    ACTIVE_QUIZ.delete(userId);
    return;
  }

  // ---------- quiz sender ----------
  private async sendQuiz(interaction: any, userId: string, channelId: string) {
    const difficulty: Difficulty = USER_DIFFICULTY.get(userId) ?? "normal";
    const pool: PoolName = USER_POOL.get(userId) ?? "standard";

    // safe defer (so we can call after a reply, e.g. skip)
    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply();
      }
    } catch {}

    const respond = async (payload: any) => {
      if (interaction.deferred) return interaction.editReply(payload);
      if (interaction.replied) return interaction.followUp(payload);
      return interaction.reply(payload);
    };

    const q = await this.quiz.buildQuiz(POOLS[pool]);

    const embed = new EmbedBuilder()
      .setTitle(`Bird Quiz (${difficulty}, ${pool} pool)`)
      .setDescription(
        difficulty === "easy"
          ? "Which species is this?"
          : "Which species is this? (answer with /qa)",
      )
      .setImage(q.imageUrl)
      .setFooter({ text: `Asset: ML${q.assetId}` });

    if (difficulty === "easy") {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        q.choices.map((c) =>
          new ButtonBuilder()
            .setCustomId(`q_pick:${userId}:${c.code}`)
            .setLabel(c.name)
            .setStyle(ButtonStyle.Secondary),
        ),
      );

      const msg = await respond({ embeds: [embed], components: [row] });
      ACTIVE_QUIZ.set(userId, {
        channelId,
        messageId: msg.id,
        easyMessageId: msg.id,
        correctCode: q.correctCode,
        correctName: q.correctName,
        correctSlug: slugify(q.correctName),
        difficulty,
        pool,
      });
      return;
    }

    const msg = await respond({ embeds: [embed] });
    ACTIVE_QUIZ.set(userId, {
      channelId,
      messageId: msg.id,
      correctCode: q.correctCode,
      correctName: q.correctName,
      correctSlug: slugify(q.correctName),
      difficulty,
      pool,
    });
  }

  private async sendAnotherPhoto(interaction: any, userId: string, st: ActiveQuiz) {
    const ch: any = interaction.channel;
    if (!ch || typeof ch.send !== "function") return;

    const { imageUrl, assetId } = await this.quiz.getPhotoForSpeciesCode(st.correctCode);

    const embed = new EmbedBuilder()
      .setTitle(`Bird Quiz (${st.difficulty}, ${st.pool} pool)`)
      .setImage(imageUrl)
      .setFooter({ text: `Asset: ML${assetId}` });

    const msg = await ch.send({ embeds: [embed] });
    ACTIVE_QUIZ.set(userId, { ...st, messageId: msg.id });
  }

  // ---------------- easy-mode button handler ----------------
  @On("interactionCreate")
  public async onInteraction(@Context() [interaction]: ContextOf<"interactionCreate">) {
    if (!interaction.isButton()) return;

    const bi = interaction as ButtonInteraction;
    if (!bi.customId.startsWith("q_pick:")) return;

    await bi.deferUpdate().catch(() => null);

    const [, lockedUserId, chosenCode] = bi.customId.split(":");
    if (bi.user.id !== lockedUserId) {
      return bi.followUp({ ephemeral: true, content: "This quiz is for someone else." });
    }

    const st = ACTIVE_QUIZ.get(lockedUserId);
    if (!st || st.easyMessageId !== bi.message.id) {
      return bi.followUp({ ephemeral: true, content: "Quiz expired." });
    }

    if (chosenCode !== st.correctCode) {
      return bi.followUp({ ephemeral: true, content: "❌ Not quite." });
    }

    ACTIVE_QUIZ.delete(lockedUserId);

    await bi
      .followUp({ ephemeral: false, content: `✅ Correct! **${st.correctName}**` })
      .catch(() => null);

    // auto-next (same pool + easy)
    const ch: any = bi.channel;
    if (!ch || typeof ch.send !== "function") return;

    const q = await this.quiz.buildQuiz(POOLS[st.pool]).catch(() => null);
    if (!q) {
      await ch
        .send("⚠️ I couldn’t generate a new quiz image right now. Try **/q start** again.")
        .catch(() => null);
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(`Bird Quiz (${st.difficulty}, ${st.pool} pool)`)
      .setDescription("Which species is this? (buttons)")
      .setImage(q.imageUrl)
      .setFooter({ text: `Asset: ML${q.assetId}` });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      q.choices.map((c) =>
        new ButtonBuilder()
          .setCustomId(`q_pick:${lockedUserId}:${c.code}`)
          .setLabel(c.name)
          .setStyle(ButtonStyle.Secondary),
      ),
    );

    const msg = await ch.send({ embeds: [embed], components: [row] }).catch(() => null);
    if (!msg) return;

    ACTIVE_QUIZ.set(lockedUserId, {
      channelId: ch.id,
      messageId: msg.id,
      easyMessageId: msg.id,
      correctCode: q.correctCode,
      correctName: q.correctName,
      correctSlug: slugify(q.correctName),
      difficulty: st.difficulty,
      pool: st.pool,
    });
  }
}

/**
 * /qa command (separate from /q parent/subcommands)
 * Keeping it separate avoids Necord parent/subcommand metadata issues.
 */
@Injectable()
export class QACommand {
  constructor(private readonly quiz: QuizService) {}

  @SlashCommand({ name: "qa", description: "Answer your current quiz (normal mode)" })
  public async onQa(
    @Context() [interaction]: SlashCommandContext,
    @Options() options: QaDto,
  ) {
    const userId = interaction.user.id;
    const channelId = interaction.channelId;

    const st = ACTIVE_QUIZ.get(userId);
    if (!st || st.channelId !== channelId) {
      return interaction.reply({ ephemeral: true, content: "No active quiz here. Use **/q start**." });
    }

    // easy mode uses buttons
    if (st.easyMessageId || st.difficulty === "easy") {
      return interaction.reply({
        ephemeral: true,
        content: "This question is **easy mode** (buttons). Use the buttons to answer.",
      });
    }

    const guessRaw = options?.guess ?? "";
    const guessSlug = slugify(guessRaw);
    if (!guessSlug) {
      return interaction.reply({
        ephemeral: true,
        content: "Try: **/qa guess:Anna's Hummingbird**",
      });
    }

    const exact = guessSlug === st.correctSlug;
    const sim = similarity(guessRaw, st.correctName);
    const ok = exact || (guessSlug.length >= 4 && sim >= 0.8);

    if (!ok) {
      return interaction.reply({ ephemeral: true, content: "❌ Not quite." });
    }

    ACTIVE_QUIZ.delete(userId);

    await interaction.reply({
      ephemeral: false,
      content: `✅ Correct! **${st.correctName}**`,
    });

    // immediately show next question
    // (reuse QCommand's logic by calling the same QuizService + building a new quiz here)
    // We'll mimic sendQuiz safely:
    const difficulty: Difficulty = USER_DIFFICULTY.get(userId) ?? "normal";
    const pool: PoolName = USER_POOL.get(userId) ?? "standard";

    // safe follow-up: we already replied above
    const ch: any = interaction.channel;
    if (!ch || typeof ch.send !== "function") return;

    const q = await this.quiz.buildQuiz(POOLS[pool]).catch(() => null);
    if (!q) {
      await ch.send("⚠️ I couldn’t generate a new quiz image right now. Try **/q start**.").catch(() => null);
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(`Bird Quiz (${difficulty}, ${pool} pool)`)
      .setDescription("Which species is this? (answer with /qa)")
      .setImage(q.imageUrl)
      .setFooter({ text: `Asset: ML${q.assetId}` });

    const msg = await ch.send({ embeds: [embed] }).catch(() => null);
    if (!msg) return;

    ACTIVE_QUIZ.set(userId, {
      channelId: ch.id,
      messageId: msg.id,
      correctCode: q.correctCode,
      correctName: q.correctName,
      correctSlug: slugify(q.correctName),
      difficulty,
      pool,
    });
  }
}
