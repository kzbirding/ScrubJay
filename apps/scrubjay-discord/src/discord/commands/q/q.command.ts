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
  type ContextOf,
  type SlashCommandContext,
} from "necord";
import { QuizService } from "./q.service";

// ---- per-user difficulty (resets on restart) ----
type Difficulty = "easy" | "normal";
const USER_DIFFICULTY = new Map<string, Difficulty>();

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

    if (action === "help") {
      return interaction.reply({
        ephemeral: true,
        content:
          "**/q** → new quiz image\n" +
          "**/q action:easy** → buttons mode (saved for you)\n" +
          "**/q action:normal** → free-response mode (saved for you)\n" +
          "**/qa guess:<species>** → answer your current quiz\n" +
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
            : "✅ Normal mode enabled. Use **/q**, then answer with **/qa guess:<species>**.",
      });
    }

    if (action === "skip" || action === "end") {
      const st = ACTIVE_QUIZ.get(userId);

      // Only the quiz owner can skip/end (by design, since state is keyed by user)
      if (!st || st.channelId !== channelId) {
        return interaction.reply({
          ephemeral: true,
          content: "No active quiz in this channel. Use **/q** first.",
        });
      }

      // Public confirmation + reveal
      await interaction.reply({
        ephemeral: false,
        content:
          action === "skip"
            ? `⏭️ **Skipped.** Answer: **${st.correctName}**`
            : `🛑 **Ended.** Answer: **${st.correctName}**`,
      });

      // Clear current quiz
      ACTIVE_QUIZ.delete(userId);

      // Skip => post a new quiz
      if (action === "skip") {
        return this.sendQuiz(interaction, userId, channelId);
      }

      return;
    }

    // action === ask
    const existing = ACTIVE_QUIZ.get(userId);
    if (existing && existing.channelId === channelId) {
      return interaction.reply({
        ephemeral: true,
        content:
          "You already have an active quiz here.\n" +
          "• Answer with **/qa guess:<species>**\n" +
          "• or skip with **/q action:skip**\n" +
          "• or end with **/q action:end**",
      });
    }

    return this.sendQuiz(interaction, userId, channelId);
  }

  @SlashCommand({
    name: "qa",
    description: "Answer your current quiz (free response)",
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

    const guessSlug = slugify(options.guess);

    // wrong answer => ephemeral
    if (!guessSlug || guessSlug !== st.correctSlug) {
      return interaction.reply({
        ephemeral: true,
        content: "❌ Not quite.",
      });
    }

    // correct answer => public + new quiz
    await interaction.reply({
      ephemeral: false,
      content: `✅ **Correct!** It was **${st.correctName}**`,
    });

    ACTIVE_QUIZ.delete(userId);

    // After answering, always provide a new photo (like skip)
    return this.sendQuiz(interaction, userId, channelId);
  }

  private async sendQuiz(interaction: any, userId: string, channelId: string) {
    const difficulty: Difficulty = USER_DIFFICULTY.get(userId) ?? "easy";

    // Only defer if we haven't already replied/deferred
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply();
    }

    // Respond helper:
    // - if already replied (like after /q skip or /qa), use followUp
    // - if deferred, editReply
    // - otherwise, reply
    const respond = async (payload: any) => {
      if (interaction.replied && !interaction.deferred) {
        return interaction.followUp(payload);
      }
      if (interaction.deferred || interaction.replied) {
        return interaction.editReply(payload);
      }
      return interaction.reply(payload);
    };

    try {
      const q = await this.quiz.buildQuiz();

      const embed = new EmbedBuilder()
        .setTitle("Bird Quiz")
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
              .setCustomId(`q_pick:${userId}:${c.code}`) // lock to quiz owner
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

      // normal mode: no buttons
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
        components: [],
      });
    }
  }

  // Button handler
  @On("interactionCreate")
  public async onInteraction(@Context() [interaction]: ContextOf<"interactionCreate">) {
    if (!interaction.isButton()) return;

    const bi = interaction as ButtonInteraction;
    if (!bi.customId.startsWith("q_pick:")) return;

    // ACK immediately to prevent “This interaction failed”
    await bi.deferUpdate().catch(() => null);

    const [, lockedUserId, chosenCode] = bi.customId.split(":");
    const clickerId = bi.user.id;

    // Only quiz owner can interact
    if (clickerId !== lockedUserId) {
      return bi
        .followUp({ ephemeral: true, content: "This quiz is for someone else." })
        .catch(() => null);
    }

    const st = ACTIVE_QUIZ.get(clickerId);
    if (!st || st.easyMessageId !== bi.message.id) {
      return bi
        .followUp({ ephemeral: true, content: "Quiz expired. Use **/q** again." })
        .catch(() => null);
    }

    const correct = chosenCode === st.correctCode;

    if (correct) {
      ACTIVE_QUIZ.delete(clickerId);
      // Public confirmation + auto-next via followUp quiz
      await bi
        .followUp({ ephemeral: true, content: `✅ Correct! **${st.correctName}**` })
        .catch(() => null);

      // Post a new photo automatically after a correct button answer
      // (uses channel.send because we’re in a button interaction context)
      const ch: any = bi.channel;
      if (!ch || typeof ch.send !== "function") return;

      const q = await this.quiz.buildQuiz().catch(() => null);
      if (!q) return;

      const embed = new EmbedBuilder()
        .setTitle("Bird Quiz")
        .setDescription("Which species is this? (buttons)")
        .setImage(q.imageUrl)
        .setFooter({ text: `Asset: ML${q.assetId}` });

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        q.choices.map((c) =>
          new ButtonBuilder()
            .setCustomId(`q_pick:${clickerId}:${c.code}`)
            .setLabel(c.name)
            .setStyle(ButtonStyle.Secondary),
        ),
      );

      const msg = await ch.send({ embeds: [embed], components: [row] }).catch(() => null);
      if (!msg) return;

      ACTIVE_QUIZ.set(clickerId, {
        channelId: ch.id,
        messageId: msg.id,
        easyMessageId: msg.id,
        correctCode: q.correctCode,
        correctName: q.correctName,
        correctSlug: slugify(q.correctName),
      });

      return;
    }

    return bi.followUp({ ephemeral: true, content: "❌ Not quite — try again." }).catch(() => null);
  }
}
