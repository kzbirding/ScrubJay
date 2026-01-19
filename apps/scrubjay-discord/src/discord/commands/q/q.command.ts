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
  StringOption,
  Subcommand,
  type ContextOf,
  type SlashCommandContext,
} from "necord";

import { QCmd } from "./q.decorator";
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

class QPoolDto {
  @StringOption({
    name: "name",
    description: "Which pool to use for future questions",
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
@QCmd()
export class QCommand {
  constructor(private readonly quiz: QuizService) {}

  // /q help
  @Subcommand({ name: "help", description: "Show quiz commands" })
  public async onHelp(@Context() [interaction]: SlashCommandContext) {
    return interaction.reply({
      ephemeral: true,
      content:
        "**/q start** → new quiz\n" +
        "**/q easy** → buttons mode\n" +
        "**/q normal** → free response mode\n" +
        "**/q pool name:<standard|expanded>** → set pool for future questions\n" +
        "**/qa guess:<species>** → answer\n" +
        "**/q photo** → another photo\n" +
        "**/q hint** → first letter (normal only)\n" +
        "**/q skip** → reveal + new\n" +
        "**/q end** → reveal + stop",
    });
  }

  // /q pool
  @Subcommand({ name: "pool", description: "Set your bird pool (applies next question)" })
  public async onPool(
    @Context() [interaction]: SlashCommandContext,
    @Options() options: QPoolDto,
  ) {
    USER_POOL.set(interaction.user.id, options.name);
    return interaction.reply({
      ephemeral: true,
      content: `✅ Pool set to **${options.name}** (applies starting your next question).`,
    });
  }

  // /q easy
  @Subcommand({ name: "easy", description: "Set easy mode (buttons)" })
  public async onEasy(@Context() [interaction]: SlashCommandContext) {
    USER_DIFFICULTY.set(interaction.user.id, "easy");
    return interaction.reply({ ephemeral: true, content: "✅ Easy mode enabled (buttons)." });
  }

  // /q normal
  @Subcommand({ name: "normal", description: "Set normal mode (free response)" })
  public async onNormal(@Context() [interaction]: SlashCommandContext) {
    USER_DIFFICULTY.set(interaction.user.id, "normal");
    return interaction.reply({ ephemeral: true, content: "✅ Normal mode enabled (free response)." });
  }

  // /q hint
  @Subcommand({ name: "hint", description: "Get a hint (normal mode only)" })
  public async onHint(@Context() [interaction]: SlashCommandContext) {
    const userId = interaction.user.id;
    const st = ACTIVE_QUIZ.get(userId);

    if (!st || st.channelId !== interaction.channelId) {
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

  // /q photo
  @Subcommand({ name: "photo", description: "Get another photo of the current species" })
  public async onPhoto(@Context() [interaction]: SlashCommandContext) {
    const userId = interaction.user.id;
    const st = ACTIVE_QUIZ.get(userId);

    if (!st || st.channelId !== interaction.channelId) {
      return interaction.reply({ ephemeral: true, content: "No active quiz here." });
    }

    await interaction.reply({ ephemeral: true, content: "📸 Getting another photo..." });
    return this.sendAnotherPhoto(interaction, userId, st);
  }

  // /q skip
  @Subcommand({ name: "skip", description: "Reveal answer and start a new question" })
  public async onSkip(@Context() [interaction]: SlashCommandContext) {
    const userId = interaction.user.id;
    const st = ACTIVE_QUIZ.get(userId);

    if (!st || st.channelId !== interaction.channelId) {
      return interaction.reply({ ephemeral: true, content: "No active quiz here." });
    }

    await interaction.reply({ content: `⏭️ Skipped. Answer: **${st.correctName}**` });
    ACTIVE_QUIZ.delete(userId);
    return this.sendQuiz(interaction, userId, interaction.channelId);
  }

  // /q end
  @Subcommand({ name: "end", description: "Reveal answer and end your quiz" })
  public async onEnd(@Context() [interaction]: SlashCommandContext) {
    const userId = interaction.user.id;
    const st = ACTIVE_QUIZ.get(userId);

    if (!st || st.channelId !== interaction.channelId) {
      return interaction.reply({ ephemeral: true, content: "No active quiz here." });
    }

    await interaction.reply({ content: `🛑 Ended. Answer: **${st.correctName}**` });
    ACTIVE_QUIZ.delete(userId);
    return;
  }

  // /q start
  @Subcommand({ name: "start", description: "Start a new quiz question" })
  public async onStart(@Context() [interaction]: SlashCommandContext) {
    const userId = interaction.user.id;
    const st = ACTIVE_QUIZ.get(userId);

    if (st && st.channelId === interaction.channelId) {
      return interaction.reply({
        ephemeral: true,
        content:
          "You already have an active quiz.\n" +
          "Use **/qa**, **/q photo**, **/q skip**, or **/q end**.",
      });
    }

    return this.sendQuiz(interaction, userId, interaction.channelId);
  }

   // ---------- quiz sender ----------
  private async sendQuiz(interaction: any, userId: string, channelId: string) {
    const difficulty: Difficulty = USER_DIFFICULTY.get(userId) ?? "normal";
    const pool: PoolName = USER_POOL.get(userId) ?? "standard";

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
