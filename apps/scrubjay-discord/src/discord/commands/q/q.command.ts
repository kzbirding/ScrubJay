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

type Difficulty = "easy" | "normal";
const USER_DIFFICULTY = new Map<string, Difficulty>();

type ActiveQuiz = {
  channelId: string;
  messageId: string;
  correctCode: string;
  correctName: string;
  correctSlug: string;
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

// Levenshtein distance for fuzzy matching
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
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
  const dist = levenshtein(A, B);
  return 1 - dist / denom;
}

type QAction = "ask" | "easy" | "normal" | "skip" | "end" | "help" | "photo" | "hint";

class QDto {
  @StringOption({
    name: "action",
    description: "Choose what to do",
    required: false,
    choices: [
      { name: "ask (new question)", value: "ask" },
      { name: "easy (buttons)", value: "easy" },
      { name: "normal (free response)", value: "normal" },
      { name: "photo (another photo)", value: "photo" },
      { name: "hint", value: "hint" },
      { name: "skip", value: "skip" },
      { name: "end", value: "end" },
      { name: "help (command list)", value: "help" },
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

  @SlashCommand({ name: "q", description: "Bird quiz" })
  public async onQ(@Context() [interaction]: SlashCommandContext, @Options() options: QDto) {
    const userId = interaction.user.id;
    const channelId = interaction.channelId;
    const action: QAction = (options?.action ?? "ask") as QAction;

    if (action === "help") {
      return interaction.reply({
        ephemeral: true,
        content:
          "**/q** → new quiz image\n" +
          "**/q easy** → buttons mode (saved for you)\n" +
          "**/q normal** → free-response mode (saved for you)\n" +
          "**/qa <species>** → answer your current quiz\n" +
          "**/q photo** → another photo of the current species\n" +
          "**/q hint** → first letter hint\n" +
          "**/q skip** → skip current question\n" +
          "**/q end** → stop quiz\n",
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

if (action === "hint") {
  const st = ACTIVE_QUIZ.get(userId);
  if (!st || st.channelId !== channelId) {
    return interaction.reply({ ephemeral: true, content: "No active quiz here. Use **/q** first." });
  }

  // ✅ Only allow hint in normal mode
  // If the current quiz has buttons, it's easy-mode
  if (st.easyMessageId) {
    return interaction.reply({
      ephemeral: true,
      content: "Hint is only available in **normal mode**. Use **/q action:normal** for your next question.",
    });
  }

  const first = st.correctName?.trim()?.[0] ?? "?";
  return interaction.reply({
    ephemeral: true,
    content: `💡 Hint: starts with **${first.toUpperCase()}**`,
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
        content:
          action === "skip"
            ? `⏭️ **Skipped.** Answer: **${st.correctName}**`
            : `🛑 **Ended.** Answer: **${st.correctName}**`,
      });

      ACTIVE_QUIZ.delete(userId);

      if (action === "skip") {
        return this.sendQuiz(interaction, userId, channelId);
      }
      return;
    }

    // ask: block if already open
    const existing = ACTIVE_QUIZ.get(userId);
    // ask: only block if user is trying to ASK while a quiz is already open
    if (action === "ask") {
      const existing = ACTIVE_QUIZ.get(userId);
      if (existing && existing.channelId === channelId) {
        return interaction.reply({
          ephemeral: true,
          content:
            "You already have an active quiz here.\n" +
            "• Answer with **/qa guess:<species>**\n" +
            "• or **/q action:photo** / **/q action:hint**\n" +
            "• or skip with **/q action:skip**\n" +
            "• or end with **/q action:end**",
        });
      }
    }


  @SlashCommand({ name: "qa", description: "Answer your current quiz" })
  public async onQa(@Context() [interaction]: SlashCommandContext, @Options() options: QaDto) {
    const userId = interaction.user.id;
    const channelId = interaction.channelId;

    const st = ACTIVE_QUIZ.get(userId);
    if (!st || st.channelId !== channelId) {
      return interaction.reply({ ephemeral: true, content: "No active quiz in this channel. Use **/q** first." });
    }

    const guess = options.guess ?? "";
    const guessSlug = slugify(guess);
    if (!guessSlug) {
      return interaction.reply({ ephemeral: true, content: "Type a guess like: **/qa guess:Anna's Hummingbird**" });
    }

    // ✅ fuzzy acceptance
    // - exact slug match always passes
    // - otherwise accept if similarity >= 0.80 and guess length reasonable
    const exact = guessSlug === st.correctSlug;
    const sim = similarity(guess, st.correctName);
    const ok = exact || (guessSlug.length >= 4 && sim >= 0.8);

    if (!ok) {
      return interaction.reply({
        ephemeral: true,
        content: `❌ Not quite.`,
      });
    }

    await interaction.reply({
      ephemeral: false,
      content: `✅ **Correct!** It was **${st.correctName}**`,
    });

    ACTIVE_QUIZ.delete(userId);

    // after correct, give a new quiz
    return this.sendQuiz(interaction, userId, channelId);
  }

  private async sendQuiz(interaction: any, userId: string, channelId: string) {
    const difficulty: Difficulty = USER_DIFFICULTY.get(userId) ?? "normal";

    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply();
    }

    const respond = async (payload: any) => {
      if (interaction.replied && !interaction.deferred) return interaction.followUp(payload);
      if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
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
      await respond({ content: "⚠️ I couldn’t generate a quiz image right now. Try again in a moment.", components: [] });
    }
  }

  private async sendAnotherPhotoSameSpecies(interaction: any, userId: string, st: ActiveQuiz) {
    // We already replied ephemerally above, so follow up publicly with a new quiz message.
    const channelId = st.channelId;

    // Fetch a new photo for the same species
    const { assetId, imageUrl } = await this.quiz.getPhotoForSpeciesCode(st.correctCode);

    const isEasy = Boolean(st.easyMessageId);

    const embed = new EmbedBuilder()
      .setTitle("Bird Quiz")
      .setDescription(isEasy ? "Another photo (buttons)" : "Another photo (answer with **/qa guess:<species>**)")
      .setImage(imageUrl)
      .setFooter({ text: `Asset: ML${assetId}` });

    const ch: any = interaction.channel;
    if (!ch || typeof ch.send !== "function") return;

    if (isEasy) {
      // Rebuild the same 4 buttons by reading the current quiz message components
      const msg0 = await ch.messages.fetch(st.easyMessageId).catch(() => null);
      const prevRow = msg0?.components?.[0];
      const buttons = prevRow?.components ?? [];

      // If we can't read the old buttons, fall back to a no-button photo
      if (!buttons.length) {
        const msg = await ch.send({ embeds: [embed] }).catch(() => null);
        if (!msg) return;

        ACTIVE_QUIZ.set(userId, { ...st, messageId: msg.id, easyMessageId: undefined });
        return;
      }

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        buttons.map((b: any) =>
          new ButtonBuilder()
            .setCustomId(b.customId)
            .setLabel(b.label)
            .setStyle(b.style ?? ButtonStyle.Secondary),
        ),
      );

      const msg = await ch.send({ embeds: [embed], components: [row] }).catch(() => null);
      if (!msg) return;

      // Update active quiz to point to the NEW message/buttons; old buttons will “expire”
      ACTIVE_QUIZ.set(userId, { ...st, messageId: msg.id, easyMessageId: msg.id });
      return;
    }

    const msg = await ch.send({ embeds: [embed] }).catch(() => null);
    if (!msg) return;
    ACTIVE_QUIZ.set(userId, { ...st, messageId: msg.id });
  }

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
      await bi.followUp({ ephemeral: true, content: `✅ Correct! **${st.correctName}**` }).catch(() => null);

      // auto-next
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
