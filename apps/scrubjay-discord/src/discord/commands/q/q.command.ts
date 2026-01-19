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
function levenshteinRaw(a: string, b: string): number {
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
  return 1 - levenshteinRaw(a, b) / denom;
}

// DTOs
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

@Injectable()
export class QCommand {
  constructor(private readonly quiz: QuizService) {}

  // ---------------- /qa (separate command) ----------------
  @SlashCommand({
    name: "qa",
    description: "Answer your current quiz (normal mode)",
  })
  public async onQa(
    @Context() [interaction]: SlashCommandContext,
    @Options() options: QaDto,
  ) {
    const userId = interaction.user.id;
    const channelId = interaction.channelId;

    const st = ACTIVE_QUIZ.get(userId);
    if (!st || st.channelId !== channelId) {
      return interaction.reply({
        ephemeral: true,
        content: "No active quiz in this channel. Use **/q** first.",
      });
    }

    // easy mode uses buttons
    if (st.easyMessageId) {
      return interaction.reply({
        ephemeral: true,
        content: "This question is in **easy mode** (buttons). Use the buttons to answer.",
      });
    }

    const guessRaw = options?.guess ?? "";
    const guessSlug = slugify(guessRaw);
    if (!guessSlug) {
      return interaction.reply({
        ephemeral: true,
        content: "Type a guess like: **/qa guess:Anna's Hummingbird**",
      });
    }

    const exact = guessSlug === st.correctSlug;
    const sim = similarity(guessRaw, st.correctName);
    const ok = exact || (guessSlug.length >= 4 && sim >= 0.8);

    if (!ok) {
      return interaction.reply({ ephemeral: true, content: "❌ Not quite." });
    }

    ACTIVE_QUIZ.delete(userId);

    // announce correct (public), then next question
    await interaction.reply({
      ephemeral: false,
      content: `✅ Correct! **${st.correctName}**`,
    });

    return this.sendQuiz(interaction, userId, channelId);
  }

  // ---------------- Parent command /q ----------------
  @SlashCommand({
    name: "q",
    description: "Bird quiz",
  })
  public async onQ(@Context() [interaction]: SlashCommandContext) {
    // /q (no subcommand) => new question
    const userId = interaction.user.id;
    const channelId = interaction.channelId;
    return this.sendQuiz(interaction, userId, channelId);
  }

  @Subcommand({
    name: "help",
    description: "Show quiz help",
  })
  public async onHelp(@Context() [interaction]: SlashCommandContext) {
    return interaction.reply({
      ephemeral: true,
      content:
        "**/q** → new quiz image\n" +
        "**/q easy** → buttons mode (saved for you)\n" +
        "**/q normal** → free-response mode (saved for you)\n" +
        "**/qa guess:<species>** → answer (normal mode; fuzzy)\n" +
        "**/q pool name:<standard|expanded>** → choose bird pool (saved for you)\n" +
        "**/q skip** → reveal answer + new image\n" +
        "**/q end** → reveal answer + stop\n",
    });
  }

  @Subcommand({
    name: "easy",
    description: "Enable easy mode (buttons)",
  })
  public async onEasy(@Context() [interaction]: SlashCommandContext) {
    USER_DIFFICULTY.set(interaction.user.id, "easy");
    return interaction.reply({
      ephemeral: true,
      content: "✅ Easy mode enabled (buttons).",
    });
  }

  @Subcommand({
    name: "normal",
    description: "Enable normal mode (free response)",
  })
  public async onNormal(@Context() [interaction]: SlashCommandContext) {
    USER_DIFFICULTY.set(interaction.user.id, "normal");
    return interaction.reply({
      ephemeral: true,
      content: "✅ Normal mode enabled (free response).",
    });
  }

  @Subcommand({
    name: "pool",
    description: "Set which bird pool you quiz from",
  })
  public async onPool(
    @Context() [interaction]: SlashCommandContext,
    @Options() options: PoolDto,
  ) {
    USER_POOL.set(interaction.user.id, options.name);
    return interaction.reply({
      ephemeral: true,
      content: `✅ Pool set to **${options.name}**.`,
    });
  }

  @Subcommand({
    name: "skip",
    description: "Reveal answer and immediately show a new question",
  })
  public async onSkip(@Context() [interaction]: SlashCommandContext) {
    const userId = interaction.user.id;
    const channelId = interaction.channelId;

    const st = ACTIVE_QUIZ.get(userId);
    if (!st || st.channelId !== channelId) {
      return interaction.reply({
        ephemeral: true,
        content: "No active quiz in this channel. Use **/q** first.",
      });
    }

    await interaction.reply({
      ephemeral: false,
      content: `⏭️ Skipped. Answer: **${st.correctName}**`,
    });

    ACTIVE_QUIZ.delete(userId);
    return this.sendQuiz(interaction, userId, channelId);
  }

  @Subcommand({
    name: "end",
    description: "Reveal answer and end your current question",
  })
  public async onEnd(@Context() [interaction]: SlashCommandContext) {
    const userId = interaction.user.id;
    const channelId = interaction.channelId;

    const st = ACTIVE_QUIZ.get(userId);
    if (!st || st.channelId !== channelId) {
      return interaction.reply({
        ephemeral: true,
        content: "No active quiz in this channel. Use **/q** first.",
      });
    }

    await interaction.reply({
      ephemeral: false,
      content: `🛑 Ended. Answer: **${st.correctName}**`,
    });

    ACTIVE_QUIZ.delete(userId);
    return;
  }

  // ---------------- quiz sender ----------------
  private async sendQuiz(interaction: any, userId: string, channelId: string) {
    const difficulty: Difficulty = USER_DIFFICULTY.get(userId) ?? "normal";
    const poolName: PoolName = USER_POOL.get(userId) ?? "standard";

    // safe defer (so we can call from /qa or /q skip after a reply)
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

    try {
      const q = await this.quiz.buildQuiz(POOLS[poolName]);

      const embed = new EmbedBuilder()
        .setTitle(`Bird Quiz (${difficulty}, ${poolName} pool)`)
        .setDescription(
          difficulty === "easy"
            ? "Which species is this? (buttons)"
            : "Which species is this? (answer with **/qa guess:<species>**)",
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
        });
        return;
      }

      const msg = await respond({ embeds: [embed], components: [] });

      ACTIVE_QUIZ.set(userId, {
        channelId,
        messageId: msg.id,
        correctCode: q.correctCode,
        correctName: q.correctName,
        correctSlug: slugify(q.correctName),
      });
    } catch (err) {
      console.error("[q] failed to build quiz:", err);
      await respond({
        content: "⚠️ I couldn’t generate a quiz image right now. Try again in a moment.",
      });
    }
  }

  // ---------------- button handler ----------------
  @On("interactionCreate")
  public async onInteraction(@Context() [interaction]: ContextOf<"interactionCreate">) {
    if (!interaction.isButton()) return;

    const bi = interaction as ButtonInteraction;
    if (!bi.customId.startsWith("q_pick:")) return;

    await bi.deferUpdate().catch(() => null);

    const [, lockedUserId, chosenCode] = bi.customId.split(":");
    const clickerId = bi.user.id;

    if (clickerId !== lockedUserId) {
      return bi.followUp({ ephemeral: true, content: "This quiz is for someone else." }).catch(() => null);
    }

    const st = ACTIVE_QUIZ.get(clickerId);
    if (!st || st.easyMessageId !== bi.message.id) {
      return bi.followUp({ ephemeral: true, content: "Quiz expired. Use **/q** again." }).catch(() => null);
    }

    const correct = chosenCode === st.correctCode;

    if (correct) {
      ACTIVE_QUIZ.delete(clickerId);
      return bi
        .followUp({ ephemeral: true, content: `✅ Correct! **${st.correctName}**` })
        .catch(() => null);
    }

    return bi.followUp({ ephemeral: true, content: "❌ Not quite — try again." }).catch(() => null);
  }

  // ---------------- normal-mode type-in-chat (still supported) ----------------
  @On("messageCreate")
  public async onMessage(@Context() [msg]: ContextOf<"messageCreate">) {
    if (!msg.author || msg.author.bot) return;

    const userId = msg.author.id;
    const st = ACTIVE_QUIZ.get(userId);
    if (!st) return;

    if (msg.channelId !== st.channelId) return;
    if (st.easyMessageId) return;

    const guess = slugify(msg.content);
    if (!guess) return;

    if (guess !== st.correctSlug) return;

    ACTIVE_QUIZ.delete(userId);
    await msg.reply(`✅ Correct! **${st.correctName}**`).catch(() => null);
  }
}
