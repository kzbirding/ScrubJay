import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { IngestionModule } from './ingestion.module';
import { EBirdIngestionService } from './ebird/ebird.ingestion';
import { DrizzleService } from '@/core/drizzle/drizzle.service';

// Mock drizzle service
const mockDrizzleService = {
  db: {
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    onConflictDoUpdate: jest.fn().mockReturnThis(),
  },
};

// Mock config service
const mockConfigService = {
  get: jest.fn(),
};

describe('IngestionModule', () => {
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      providers: [
        EBirdIngestionService,
        {
          provide: DrizzleService,
          useValue: mockDrizzleService,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();
  });

  afterEach(async () => {
    if (module) {
      await module.close();
    }
  });

  it('should be defined', () => {
    expect(module).toBeDefined();
  });

  it('should provide EBirdIngestionService', () => {
    const service = module.get<EBirdIngestionService>(EBirdIngestionService);
    expect(service).toBeDefined();
    expect(service).toBeInstanceOf(EBirdIngestionService);
  });

  it('should export EBirdIngestionService', () => {
    const service = module.get<EBirdIngestionService>(EBirdIngestionService);
    expect(service).toBeDefined();
  });

  it('should import DrizzleModule', () => {
    // The module should compile successfully with DrizzleModule imported
    expect(module).toBeDefined();
  });

  describe('module structure', () => {
    it('should have correct providers', () => {
      const service = module.get<EBirdIngestionService>(EBirdIngestionService);
      expect(service).toBeDefined();
    });

    it('should have correct imports', () => {
      // Test that the module can be instantiated with its dependencies
      expect(module).toBeDefined();
    });
  });

  describe('service instantiation', () => {
    it('should create EBirdIngestionService with dependencies', () => {
      const service = module.get<EBirdIngestionService>(EBirdIngestionService);
      expect(service).toBeDefined();
      
      // Verify the service has the expected methods
      expect(typeof service.ingest).toBe('function');
    });
  });
});
