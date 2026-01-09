import { StringOption, BooleanOption } from "necord";

/**
 * Discord rule:
 * All REQUIRED options must come BEFORE any OPTIONAL options
 * within each (sub)command.
 *
 * To avoid decorator metadata ordering quirks, do NOT use class inheritance here.
 */

export class MeetupPreviewDto {
  // REQUIRED (must be first)
  @StringOption({ name: "title", description: "Meetup title", required: true })
  title!: string;

  @StringOption({ name: "date", description: "Date (YYYY-MM-DD)", required: true })
  date!: string;

  @StringOption({
    name: "start_time",
    description: "Start time (HH:MM, 24h)",
    required: true,
  })
  startTime!: string;

  @StringOption({
    name: "location",
    description: "Location / hotspot link",
    required: true,
  })
  location!: string;

  // OPTIONAL (only after all required)
  @StringOption({
    name: "end_time",
    description: "End time (HH:MM, 24h)",
    required: false,
  })
  endTime?: string;

  @StringOption({
    name: "skill_level",
    description: "Skill level (optional)",
    required: false,
  })
  skillLevel?: string;

  @StringOption({
    name: "notes",
    description: "Extra notes (optional)",
    required: false,
  })
  notes?: string;
}

export class MeetupCreateDto {
  // REQUIRED (must be first)
  @StringOption({ name: "title", description: "Meetup title", required: true })
  title!: string;

  @StringOption({ name: "date", description: "Date (YYYY-MM-DD)", required: true })
  date!: string;

  @StringOption({
    name: "start_time",
    description: "Start time (HH:MM, 24h)",
    required: true,
  })
  startTime!: string;

  @StringOption({
    name: "location",
    description: "Location / hotspot link",
    required: true,
  })
  location!: string;

  // OPTIONAL (only after all required)
  @StringOption({
    name: "end_time",
    description: "End time (HH:MM, 24h)",
    required: false,
  })
  endTime?: string;

  @StringOption({
    name: "skill_level",
    description: "Skill level (optional)",
    required: false,
  })
  skillLevel?: string;

  @StringOption({
    name: "notes",
    description: "Extra notes (optional)",
    required: false,
  })
  notes?: string;

  @BooleanOption({
    name: "create_rsvp_panel",
    description: "Create RSVP panel (later)",
    required: false,
  })
  createRsvpPanel?: boolean;

  @BooleanOption({
    name: "generate_graphic",
    description: "Generate a graphic (later)",
    required: false,
  })
  generateGraphic?: boolean;
}
