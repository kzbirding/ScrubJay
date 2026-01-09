import { StringOption, BooleanOption } from "necord";

export class MeetupPreviewDto {
  @StringOption({ name: "title", description: "Meetup title", required: true })
  title!: string;

  @StringOption({
    name: "date",
    description: "Date (YYYY-MM-DD)",
    required: true,
  })
  date!: string;

  @StringOption({
    name: "start_time",
    description: "Start time (HH:MM, 24h)",
    required: true,
  })
  startTime!: string;

  @StringOption({
    name: "end_time",
    description: "End time (HH:MM, 24h)",
    required: false,
  })
  endTime?: string;

  @StringOption({
    name: "location",
    description: "Location / hotspot link",
    required: true,
  })
  location!: string;

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

export class MeetupCreateDto extends MeetupPreviewDto {
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
