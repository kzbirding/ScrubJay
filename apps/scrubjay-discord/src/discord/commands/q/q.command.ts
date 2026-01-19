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
import { STANDARD_POOL } from "./standard.pool";
import { EXPANDED_POOL } from "./expanded.pool";

type Difficulty = "easy" | "normal";
const USER_DIFFICULTY = new Map<string, Difficulty>();

type PoolName = "standard" | "expanded";
const USER_POOL = new Map<string, PoolName>();
const POOLS: Record<PoolName, readonly string[]> = {
  standard: STANDARD_POOL,
  expanded: EXPANDED_POOL,
};

type ActiveQuiz = {
  channelId: string;
  messageId: string;
  correctCode: string;
  correctName: string;
  correctSlug: string;
  difficulty: Difficulty;
  pool: PoolName;
  easyMessageId?: string;
};
const ACTIVE_QUIZ = new Map<string, ActiveQuiz>();

function slugify(s: string): string {
  return (s || "")
    .toLowerCase()
    .trim()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type QAction = "ask" | "easy" | "normal" | "photo" | "hint" | "skip" | "end" | "help";

class QDto {
  @StringOption({
    name: "action",
    description: "Choose what to do",
    required: false,
    choices: [
      { name: "new quiz", value: "ask" },
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

  @StringOption({
    name: "pool",
    description: "Choose which bird pool to quiz from (applies starting next question)",
    required: false,
    choices: [
      { name: "standard", value: "standard" },
      { name: "expanded", value: "expanded" },
    ],
  })
  pool?: PoolName;
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

  // ---------- /q ----------
  @SlashCommand({ name: "q", description: "Bird quiz" })
  public async onQ(
    @Context() [interaction]: SlashCommandContext,
    @Options() options: QDto,
  ) {
    const userId = interaction.user.id;
    const channelId = interaction.channelId;
    const action: QAction = (options?.action ?? "ask") as QAction;

    // ---- pool selection (applies starting next question; does NOT send a quiz) ----
    if (options?.pool) {
      USER_POOL.set(userId, options.pool);
      return interaction.reply({
        ephemeral: true,
        content: `✅ Pool set to **${options.pool}** (applies starting your next question).`,
      });
    }

    // ---- help ----
    if (action === "help") {
      return interaction.reply({
        ephemeral: true,
        content:
          "**/q** → new quiz\n" +
          "**/q action:easy** → buttons mode\n" +
          "**/q action:normal** → free response mode\n" +
          "**/q pool:<standard|expanded>** → set pool for future questions\n" +
          "**/qa guess:<species>** → answer\n" +
          "**/q photo** → another photo\n" +
          "**/q hint** → first letter (normal only)\n" +
          "**/q skip** → reveal + new\n" +
          "**/q end** → reveal + stop",
      });
    }

    // ---- difficulty ----
    if (action === "easy" || action === "normal") {
      USER_DIFFICULTY.set(userId, action);
      return interaction.reply({
        ephemeral: true,
        content:
          action === "easy"
            ? "✅ Easy mode enabled (buttons)."
            : "✅ Normal mode enabled (free response).",
      });
    }

    const st = ACTIVE_QUIZ.get(userId);

    // ---- hint (normal only) ----
    if (action === "hint") {
      if (!st || st.channelId !== channelId) {
        return interaction.reply({ ephemeral: true, content: "No active quiz here." });
      }
      if (st.easyMessageId) {
        return interaction.reply({
          ephemeral: true,
          content: "Hints are only available in **normal mode**.",
        });
      }
      return interaction.reply({
        ephemeral: true,
        content: `💡 Starts with **${st.correctName[0].toUpperCase()}**`,
      });
    }

    // ---- photo ----
    if (action === "photo") {
      if (!st || st.channelId !== channelId) {
        return interaction.reply({ ephemeral: true, content: "No active quiz here." });
      }
      await interaction.reply({
        ephemeral: true,
        content: `📸 Getting another photo...`,
      });
      return this.sendAnotherPhoto(interaction, userId, st);
    }

    // ---- skip / end ----
    if (action === "skip" || action === "end") {
      if (!st || st.channelId !== channelId) {
        return interaction.reply({ ephemeral: true, content: "No active quiz here." });
      }

      await interaction.reply({
        content:
          action === "skip"
            ? `⏭️ Skipped. Answer: **${st.correctName}**`
            : `🛑 Ended. Answer: **${st.correctName}**`,
      });

      ACTIVE_QUIZ.delete(userId);
      if (action === "skip") return this.sendQuiz(interaction, userId, channelId);
      return;
    }

    // ---- ask ----
    if (action === "ask" && st && st.channelId === channelId) {
      return interaction.reply({
        ephemeral: true,
        content:
          "You already have an active quiz.\n" +
          "Use **/qa**, **/q action:photo**, **/q action:skip**, or **/q action:end**.",
      });
    }

    return this.sendQuiz(interaction, userId, channelId);
  }

  // ---------- /qa ----------
  @SlashCommand({ name: "qa", description: "Answer your current quiz" })
  public async onQa(
    @Context() [interaction]: SlashCommandContext,
    @Options() options: QaDto,
  ) {
    const userId = interaction.user.id;
    const channelId = interaction.channelId;
    const st = ACTIVE_QUIZ.get(userId);

    if (!st || st.channelId !== channelId) {
      return interaction.reply({ ephemeral: true, content: "No active quiz here." });
    }

    if (slugify(options.guess) !== st.correctSlug) {
      return interaction.reply({ ephemeral: true, content: "❌ Not quite." });
    }

    await interaction.reply({ content: `✅ Correct! **${st.correctName}**` });
    ACTIVE_QUIZ.delete(userId);
    return this.sendQuiz(interaction, userId, channelId);
  }

  // ---------- quiz sender ----------
  private async sendQuiz(interaction: any, userId: string, channelId: string) {
    const difficulty: Difficulty = USER_DIFFICULTY.get(userId) ?? "normal";
    const pool: PoolName = USER_POOL.get(userId) ?? "standard";

    // 🚫 NEVER crash if already replied
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

  // ---------- photo helper ----------
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

  // ---------- button handler ----------
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

    // correct
    ACTIVE_QUIZ.delete(lockedUserId);

    // confirm correct
    await bi
      .followUp({ ephemeral: false, content: `✅ Correct! **${st.correctName}**` })
      .catch(() => null);

    // auto-next: new quiz w/ same pool
    const ch: any = bi.channel;
    if (!ch || typeof ch.send !== "function") return;

    const q = await this.quiz.buildQuiz(POOLS[st.pool]).catch(() => null);
    if (!q) {
      await ch
        .send("⚠️ I couldn’t generate a new quiz image right now. Try **/q** again.")
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

    return;
  }
}
