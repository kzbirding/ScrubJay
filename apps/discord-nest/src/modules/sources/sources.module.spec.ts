import { Test, TestingModule } from '@nestjs/testing';
import { SourcesModule } from './sources.module';
import { SourcesService } from './sources.service';
import { DrizzleService } from '@/core/drizzle/drizzle.service';

// Mock the DrizzleService
const mockDrizzleService = {
  db: {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
  },
};

describe('SourcesModule', () => {
  let module: TestingModule;
  let sourcesService: SourcesService;
  let drizzleService: DrizzleService;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      providers: [
        SourcesService,
        {
          provide: DrizzleService,
          useValue: mockDrizzleService,
        },
      ],
      exports: [SourcesService],
    }).compile();

    sourcesService = module.get<SourcesService>(SourcesService);
    drizzleService = module.get<DrizzleService>(DrizzleService);
  });

  afterEach(async () => {
    if (module) {
      await module.close();
    }
  });

  it('should be defined', () => {
    expect(module).toBeDefined();
  });

  it('should provide SourcesService', () => {
    expect(sourcesService).toBeDefined();
    expect(sourcesService).toBeInstanceOf(SourcesService);
  });

  it('should provide DrizzleService', () => {
    expect(drizzleService).toBeDefined();
    expect(drizzleService).toEqual(mockDrizzleService);
  });

  it('should export SourcesService', () => {
    const exportedService = module.get<SourcesService>(SourcesService);
    expect(exportedService).toBeDefined();
  });

  describe('module dependencies', () => {
    it('should have SourcesService as provider', () => {
      const moduleMetadata = Reflect.getMetadata('providers', SourcesModule);
      expect(moduleMetadata).toContain(SourcesService);
    });

    it('should export SourcesService', () => {
      const moduleMetadata = Reflect.getMetadata('exports', SourcesModule);
      expect(moduleMetadata).toContain(SourcesService);
    });
  });

  describe('service integration', () => {
    it('should have SourcesService with injected DrizzleService', () => {
      // Access private property to verify injection
      const drizzleInjected = sourcesService['drizzle'];
      expect(drizzleInjected).toBeDefined();
      expect(drizzleInjected).toBe(drizzleService);
    });
  });
});
