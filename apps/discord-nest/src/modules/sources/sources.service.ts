import { DatabaseService } from "@/core/database/database.service";
import { sources } from "@/core/database/schema";
import { eq, and } from "drizzle-orm";
import { Injectable, Logger } from "@nestjs/common";
import { 
    ConfigFor, 
    SourceConfigSchema, 
    SourceType,
} from "./sources.schema";

@Injectable()
export class SourcesService {

    private readonly logger = new Logger(SourcesService.name);

    constructor(private readonly db: DatabaseService) {}

    async findActiveByType(type: SourceType) {
        return this.db.query.sources.findMany({
            where: and(eq(sources.type, type), eq(sources.active, true)),
        })
    }

    async findById(id: string) {
        return this.db.query.sources.findFirst({
            where: eq(sources.id, id),
        })
    }

    async upsertSource<T extends SourceType>(data: {
        id: string;
        type: T;
        url: string | null;
        config: ConfigFor<T>;
        fetchIntervalMin: number;
    }) {
        const now = new Date();
        
        await this.db.insert(sources).values({
            id: data.id,
            type: data.type,
            url: data.url,
            config: data.config,
            fetchIntervalMin: data.fetchIntervalMin,
            active: true,
            createdAt: now,
            updatedAt: now,
        }).onConflictDoUpdate({
            target: [sources.id],
            set: {
                config: data.config,
                url: data.url,
                fetchIntervalMin: data.fetchIntervalMin,
                active: true,
                updatedAt: now,
            },
        });

        this.logger.log(`Upserted source ${data.id}`);
    }

    async deactivate(id: string) {
        await this.db.update(sources).set({
            active: false,
            updatedAt: new Date(),
        }).where(eq(sources.id, id));

        this.logger.warn(`Deactivated source ${id}`);
    }

    async listAllActive() {
        return this.db.query.sources.findMany({
            where: eq(sources.active, true),
            orderBy: s => s.type,
        })
    }

    async parseConfig<T extends SourceType>(id: string, type: T): Promise<ConfigFor<T>> {
        const source = await this.db.query.sources.findFirst({
            where: and(eq(sources.id, id)),
        })

        if (!source) {
            throw new Error(`Source ${id} not found`);
        }

        if (!source.config) {
            throw new Error(`Source ${id} has no config`);
        }

        try {
            const rawConfig = typeof source.config === 'string' ? JSON.parse(source.config) : source.config;

            const validatedConfig = SourceConfigSchema.parse(rawConfig);

            if (validatedConfig.type !== type) {
                throw new Error(`Source ${id} is not of type ${type}`);
            }

            return validatedConfig.config;
        } catch (error) {
            this.logger.error(`Error parsing config for source ${id}:`, error);
            throw error;
        }
    }
}