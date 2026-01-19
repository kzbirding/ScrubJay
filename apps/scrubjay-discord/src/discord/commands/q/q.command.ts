import { Injectable } from "@nestjs/common";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type ButtonInteraction,
  type Message,
} from "discord.js";
import {
  Context,
  On,
  Options,
  SlashCommand,
  StringOption,
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

type QAction = "ask" | "easy" | "normal" | "skip" | "end" | "help";

class QDto {
  @StringOption({
    name: "action",
    description: "Choose what to do",
    required: false,
    choices: [
      { name: "ask (new question)", value: "ask" },
      { name: "easy (buttons)", value: "easy" },
      { name: "normal (free response)", value: "normal" },
      { name: "skip (reveal + new)", value: "skip" },
      { name: "end (reveal + stop)", value: "end" },
      { name: "help", value: "help" },
    ],
  })
  action?: QAction;

  @StringOption({
    name: "pool",
    description: "Choose which bird pool to quiz from (saved for you)",
    required: false,
    choices: [
      { name: "standard", value: "standard" },
      { name: "expanded", value: "expanded" },
    ],
  })
  pool?: PoolName;
}

@Injectable()
export class QCommand {
  constructor(private readonly quiz: QuizService) {}

  @SlashCommand({
    name: "q",
    description: "Bird quiz (easy buttons or normal free response)",
  })
  public async onQ(
    @Context() [interaction]: SlashCommandContext,
    @Options() options: QDto,
  ) {
    const userId = interaction.user.id;
    const channelId = interaction.channelId;

    const action: QAction = (options?.action ?? "ask") as QAction;

    // pool selection (saved per user; resets on restart)
    if (options?.pool) {
      USER_POOL.set(userId, options.pool);
      return interaction.reply({
        ephemeral: true,
        content: `✅ Pool set to **${options.pool}**.`,
      });
    }

    if (action === "help") {
      return interaction.reply({
        ephemeral: true,
        content:
          "**/q** → new quiz image\n" +
          "**/q action:easy** → buttons mode (saved for you)\n" +
          "**/q action:normal** → free-response mode (saved for you)\n" +
          "**/q pool:<standard|expanded>** → choose bird pool (saved for you)\n" +
          "**/q action:skip** → reveal answer + new image\n" +
          "**/q action:end** → reveal answer + stop\n",
      });
    }

    if (action === "easy" || action === "normal") {
      USER_DIFFICULTY.set(userId, action);
      return interaction.reply({
        ephemeral: true,
        content:
          action === "easy"
            ? "✅ Easy mode enabled (buttons). Use **/q** to get a question."
            : "✅ Normal mode enabled (type your guess in chat). Use **/q** to get a question.",
      });
    }

    if (action === "skip" || action === "end") {
      const st = ACTIVE_QUIZ.get(userId);
      if (!st || st.channelId !== channelId) {
        return interaction.reply({
          ephemeral: true,
          content: "No active quiz in this channel. Use **/q** first.",
        });
      }

      await interaction.reply({
        ephemeral: false,
        content: `✅ Answer: **${st.correctName}**`,
      });

      ACTIVE_QUIZ.delete(userId);

      if (action === "end") return;
      return this.sendQuiz(interaction, userId, channelId);
    }

    // default: ask
    return this.sendQuiz(interaction, userId, channelId);
  }

  private async sendQuiz(interaction: any, userId: string, channelId: string) {
    const difficulty: Difficulty = USER_DIFFICULTY.get(userId) ?? "normal";
    const poolName: PoolName = USER_POOL.get(userId) ?? "standard";

    await interaction.deferReply();

    try {
      const q = await this.quiz.buildQuiz(POOLS[poolName]);

      const embed = new EmbedBuilder()
        .setTitle(`Bird Quiz (${difficulty}, ${poolName} pool)`)
        .setDescription(
          difficulty === "easy"
            ? "Which species is this? (buttons)"
            : "Which species is this? (type your guess in chat)",
        )
        .setImage(q.imageUrl)
        .setFooter({ text: `Asset: ML${q.assetId}` });

      if (difficulty === "easy") {
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          q.choices.map((c) =>
            new ButtonBuilder()
              .setCustomId(`q_pick:${userId}:${c.code}`) // lock to user
              .setLabel(c.name)
              .setStyle(ButtonStyle.Secondary),
          ),
        );

        const msg = await interaction.editReply({ embeds: [embed], components: [row] });

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

      // normal mode: no buttons
      const msg = await interaction.editReply({ embeds: [embed], components: [] });

      ACTIVE_QUIZ.set(userId, {
        channelId,
        messageId: msg.id,
        correctCode: q.correctCode,
        correctName: q.correctName,
        correctSlug: slugify(q.correctName),
      });
    } catch (err) {
      console.error("[q] failed to build quiz:", err);
      await interaction.editReply({
        content: "⚠️ I couldn’t generate a quiz image right now. Try again in a moment.",
      });
    }
  }

  // ✅ Button handler with correct Necord context typing
  @On("interactionCreate")
  public async onInteraction(@Context() [interaction]: ContextOf<"interactionCreate">) {
    if (!interaction.isButton()) return;

    const bi = interaction as ButtonInteraction;
    if (!bi.customId.startsWith("q_pick:")) return;

    // ACK immediately to prevent “This interaction failed”
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
      return bi.followUp({ ephemeral: true, content: `✅ Correct! **${st.correctName}**` }).catch(() => null);
    }

    return bi.followUp({ ephemeral: true, content: "❌ Not quite — try again." }).catch(() => null);
  }

  // ✅ Normal mode: free-response guesses
  @On("messageCreate")
  public async onMessage(@Context() [msg]: ContextOf<"messageCreate">) {
    if (!msg.author || msg.author.bot) return;

    const userId = msg.author.id;
    const st = ACTIVE_QUIZ.get(userId);
    if (!st) return;

    // only accept guesses in same channel
    if (msg.channelId !== st.channelId) return;

    // only normal mode quizzes (no buttons)
    if (st.easyMessageId) return;

    const guess = slugify(msg.content);
    if (!guess) return;

    if (guess !== st.correctSlug) return;

    ACTIVE_QUIZ.delete(userId);
    await msg.reply(`✅ Correct! **${st.correctName}**`).catch(() => null);
  }
}
