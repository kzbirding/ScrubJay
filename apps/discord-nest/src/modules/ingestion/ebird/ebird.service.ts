import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '@/core/database/database.service';
import { sources } from '@/core/database/schema';
import { SourcesService } from '../../sources/sources.service';
import { ConfigFor } from '../../sources/sources.schema';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class EBirdService {
    private readonly logger = new Logger(EBirdService.name);
    private readonly ebirdBaseUrl: string;

    constructor(
        private readonly databaseService: DatabaseService,
        private readonly sourcesService: SourcesService,
        private readonly configService: ConfigService
    ) {
        this.ebirdBaseUrl = this.configService.getOrThrow('EBIRD_BASE_URL');    
    }

    async ingest(sourcesList: typeof sources.$inferSelect[]) {
        const results = await Promise.allSettled(
            sourcesList.map(async (source) => {
                try {
                    const config = await this.sourcesService.parseConfig(source.id, 'EBIRD');
                    return this.processEBirdSource(source, config);
                } catch (error) {
                    this.logger.error(`Failed to process eBird source ${source.id}:`, error);
                    throw error;
                }
            })
        );
        

        const successful = results.filter(r => r.status === 'fulfilled').length;
        const failed = results.filter(r => r.status === 'rejected').length;
        
        this.logger.log(`Processed ${successful} eBird sources successfully, ${failed} failed`);
        
        return { totalPosted: successful };
    }

    private async processEBirdSource(source: typeof sources.$inferSelect, config: ConfigFor<'EBIRD'>) {
        this.logger.log(`Processing eBird source: ${config.regionName} (${config.regionCode}).`);

        const response = await fetch(new URL(`/v2/data/obs/${config.regionCode}/recent/notable?detail=full&back=7`, this.ebirdBaseUrl), {
            headers: {
                'X-eBirdApiToken': this.configService.getOrThrow('EBIRD_TOKEN'),
            },
        });
        const data = await response.json();
        console.log(data);

        return { sourceId: source.id, processed: 0 };
    }

    private async fetchRareObservations(regionCode: string) {
        const token = this.configService.getOrThrow('EBIRD_TOKEN');
        const url = new URL(`/v2/data/obs/${regionCode}/recent/notable?detail=full&back=7`, this.ebirdBaseUrl);

        const res = await fetch(url, {
            headers: {
                'X-eBirdApiToken': token,
            },
        })

        if (!res.ok) {
            this.logger.warn(`eBird API ${res.status} for region ${regionCode}`);
            return []
        }

        return (await res.json())
    }
}