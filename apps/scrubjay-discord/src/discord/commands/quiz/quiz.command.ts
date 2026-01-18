import { Injectable } from "@nestjs/common";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type ButtonInteraction,
} from "discord.js";
import { Context, On, SlashCommand, type SlashCommandContext } from "necord";

import { QuizService } from "./quiz.service";

const QUIZ_STATE = new Map<string, { correctCode: string }>(); // messageId -> correct speciesCode

@Injectable()
export class QuizCommand {
  constructor(private readonly quiz: QuizService) {}

  @SlashCommand({ name: "quiz", description: "Bird photo quiz (SoCal list)" })
  public async onQuiz(@Context() [interaction]: SlashCommandContext) {
    await interaction.deferReply();

    try {
      const q = await this.quiz.buildQuiz();

      const embed = new EmbedBuilder()
        .setTitle("Bird Quiz")
        .setDescription("Which species is this?")
        .setImage(q.imageUrl)
        .setFooter({ text: `Asset: ML${q.assetId}` });

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        q.choices.map((c) =>
          new ButtonBuilder()
            .setCustomId(`quiz_pick:${c.code}`)
            .setLabel(c.name)
            .setStyle(ButtonStyle.Secondary),
        ),
      );

      const msg = await interaction.editReply({
        embeds: [embed],
        components: [row],
      });

      QUIZ_STATE.set(msg.id, { correctCode: q.correctCode });
    } catch (err) {
      // 🔒 CRITICAL: prevent bot crash
      console.error("[quiz] failed to build quiz:", err);

      await interaction.editReply({
        content:
          "⚠️ I couldn’t generate a quiz image right now. " +
          "Try again in a moment — Macaulay sometimes fails to return photos.",
      });
    }
  }

  @On("interactionCreate")
  public async onInteraction(interaction: any) {
    if (!interaction?.isButton?.()) return;

    const bi = interaction as ButtonInteraction;
    if (!bi.customId.startsWith("quiz_pick:")) return;

    const state = QUIZ_STATE.get(bi.message.id);
    if (!state) {
      return bi.reply({ ephemeral: true, content: "Quiz expired." });
    }

    const chosenCode = bi.customId.split(":")[1];
    const correct = chosenCode === state.correctCode;

    if (correct) {
      QUIZ_STATE.delete(bi.message.id);
    }

    return bi.reply({
      ephemeral: true,
      content: correct ? "✅ Correct!" : "❌ Not quite — try again.",
    });
  }
}
