import { Injectable } from "@nestjs/common";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type ButtonInteraction,
  type Message,
} from "discord.js";
import { Context, On, Options, SlashCommand, type SlashCommandContext } from "necord";
import { QuizService } from "../q/q.service";

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
  // in easy mode, track which message has the buttons
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

class QOptions {
  // optional "action" choice
  // (Necord will still accept plain /q with no option)
  action?: QAction;
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
    @Options() options: QOptions,
  ) {
    const userId = interaction.user.id;
    const channelId = interaction.channelId;

    const action = (options?.action ?? "ask") as QAction;

    if (action === "help") {
      return interaction.reply({
        ephemeral: true,
        content:
          "**/q** — sends a new quiz image\n" +
          "**/q action:easy** — easy mode (4 buttons)\n" +
          "**/q action:normal** — normal mode (type your guess in chat)\n" +
          "**/q action:skip** — reveal answer + new image\n" +
          "**/q action:end** — reveal answer + stop\n",
      });
    }

    if (action === "easy" || action === "normal") {
      USER_DIFFICULTY.set(userId, action);
      return interaction.reply({
        ephemeral: true,
        content: action === "easy"
          ? "✅ Easy mode enabled (buttons). Use **/q** to get a question."
          : "✅ Normal mode enabled (free response). Use **/q** and then type your guess in chat.",
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

      // reveal answer
      await interaction.reply({
        ephemeral: false,
        content: `✅ Answer: **${st.correctName}**`,
      });

      // clear current
      ACTIVE_QUIZ.delete(userId);

      if (action === "end") return;

      // new quiz
      return this.sendQuiz(interaction, userId, channelId);
    }

    // default: ask
    return this.sendQuiz(interaction, userId, channelId);
  }

  private async sendQuiz(interaction: any, userId: string, channelId: string) {
    const difficulty: Difficulty = USER_DIFFICULTY.get(userId) ?? "easy";

    await interaction.deferReply();

    try {
      const q = await this.quiz.buildQuiz();

      const embed = new EmbedBuilder()
        .setTitle("Bird Quiz")
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
              .setCustomId(`q_pick:${userId}:${c.code}`) // lock buttons to that user
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

      // normal mode (no buttons)
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

  // ---- Fix button “interaction failed” ----
  @On("interactionCreate")
  public async onButton(interaction: any) {
    if (!interaction?.isButton?.()) return;

    const bi = interaction as ButtonInteraction;
    if (!bi.customId.startsWith("q_pick:")) return;

    // ACK immediately so Discord doesn’t show “interaction failed”
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
      await bi.followUp({ ephemeral: true, content: `✅ Correct! **${st.correctName}**` }).catch(() => null);

      // auto next question
      // (if you don’t want auto-next, tell me and I’ll remove this)
      // We can’t reuse the interaction reply here, so just send a new message in channel:
      const ch = bi.channel;
      if (ch && "send" in ch) {
        // create a minimal fake interaction-like object for sendQuiz (or just call quiz service directly)
        const q = await this.quiz.buildQuiz().catch(() => null);
        if (q) {
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

          const msg = await (ch as any).send({ embeds: [embed], components: [row] }).catch(() => null);
          if (msg) {
            ACTIVE_QUIZ.set(clickerId, {
              channelId: ch.id,
              messageId: msg.id,
              easyMessageId: msg.id,
              correctCode: q.correctCode,
              correctName: q.correctName,
              correctSlug: slugify(q.correctName),
            });
          }
        }
      }
      return;
    }

    return bi.followUp({ ephemeral: true, content: "❌ Not quite — try again." }).catch(() => null);
  }

  // ---- Normal mode: free-response guesses ----
  @On("messageCreate")
  public async onGuess(msg: Message) {
    if (!msg?.author || msg.author.bot) return;

    const userId = msg.author.id;
    const st = ACTIVE_QUIZ.get(userId);
    if (!st) return;

    // only accept guesses in same channel
    if (msg.channelId !== st.channelId) return;

    // only in normal mode (no easyMessageId)
    if (st.easyMessageId) return;

    const guess = slugify(msg.content);
    if (!guess) return;

    // forgiving: exact slug match
    if (guess !== st.correctSlug) return;

    // correct
    ACTIVE_QUIZ.delete(userId);

    await msg.reply(`✅ Correct! **${st.correctName}**`).catch(() => null);

    // auto next question
    const q = await this.quiz.buildQuiz().catch(() => null);
    if (!q) return;

    const embed = new EmbedBuilder()
      .setTitle("Bird Quiz")
      .setDescription("Which species is this? (type your guess in chat)")
      .setImage(q.imageUrl)
      .setFooter({ text: `Asset: ML${q.assetId}` });

      const ch: any = msg.channel;
      if (!ch || typeof ch.send !== "function") return;

      const sent = await ch.send({ embeds: [embed] }).catch(() => null);


    ACTIVE_QUIZ.set(userId, {
      channelId: msg.channelId,
      messageId: sent.id,
      correctCode: q.correctCode,
      correctName: q.correctName,
      correctSlug: slugify(q.correctName),
    });
  }
}
