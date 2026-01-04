import { IntegerOption, StringOption } from "necord";

export class SubscribeEBirdCommandDto {
  @StringOption({
    description: "The region code to subscribe to",
    name: "region",
    required: true,
  })
  region: string;
}

export class PhotoCommandDto {
  @StringOption({
    description: 'Bird name (e.g., "American Avocet")',
    name: "query",
    required: true,
  })
  query: string;

  @IntegerOption({
    description: "Number of photos (1–4)",
    name: "count",
    required: false,
    min_value: 1,
    max_value: 4,
  })
  count?: number;
}
