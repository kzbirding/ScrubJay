import { z } from "zod";


const EBirdConfig = z.object({
    regionName: z.string().describe('The name of the region to monitor'),
    regionCode: z.string().describe('The code of the region to monitor'),
});

export const SourceConfigSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('EBIRD'), config: EBirdConfig }),
]);

export type SourceConfig = z.infer<typeof SourceConfigSchema>;
export type SourceType = SourceConfig['type'];
export type ConfigFor<T extends SourceType> = Extract<SourceConfig, { type: T }>['config'];