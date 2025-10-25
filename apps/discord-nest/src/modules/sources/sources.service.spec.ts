import { Test, TestingModule } from '@nestjs/testing';
import { SourcesService } from './sources.service';
import { DrizzleService } from '@/core/drizzle/drizzle.service';
import { EBirdSource } from './sources.schema';

// Mock the drizzle service
const mockDrizzleService = {
  db: {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
  },
};

describe('SourcesService', () => {
  let service: SourcesService;
  let drizzleService: DrizzleService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SourcesService,
        {
          provide: DrizzleService,
          useValue: mockDrizzleService,
        },
      ],
    }).compile();

    service = module.get<SourcesService>(SourcesService);
    drizzleService = module.get<DrizzleService>(DrizzleService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getActiveEBirdSources (via getActiveSourcesByType)', () => {
    it('should return active eBird sources successfully', async () => {
      const mockSources: EBirdSource[] = [
        {
          id: '550e8400-e29b-41d4-a716-446655440001',
          type: 'EBIRD',
          fetchIntervalMin: 20,
          active: true,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-01'),
          config: {
            regionName: 'San Diego County',
            regionCode: 'US-CA-073',
          },
        },
        {
          id: '550e8400-e29b-41d4-a716-446655440002',
          type: 'EBIRD',
          fetchIntervalMin: 30,
          active: true,
          createdAt: new Date('2024-01-02'),
          updatedAt: new Date('2024-01-02'),
          config: {
            regionName: 'Los Angeles County',
            regionCode: 'US-CA-037',
          },
        },
      ];

      // Mock the database query chain
      mockDrizzleService.db.where.mockResolvedValue(mockSources);

      const result = await service.getActiveSourcesByType('EBIRD');

      expect(result).toEqual(mockSources);
      expect(mockDrizzleService.db.select).toHaveBeenCalled();
      expect(mockDrizzleService.db.from).toHaveBeenCalled();
      expect(mockDrizzleService.db.innerJoin).toHaveBeenCalled();
      expect(mockDrizzleService.db.where).toHaveBeenCalled();
    });

    it('should handle database errors and log them', async () => {
      const error = new Error('Database connection failed');
      mockDrizzleService.db.where.mockRejectedValue(error);

      // Mock the logger to capture error logs
      const loggerSpy = jest.spyOn(service['logger'], 'error');

      await expect(service.getActiveSourcesByType('EBIRD')).rejects.toThrow(
        'Database connection failed'
      );

      expect(loggerSpy).toHaveBeenCalledWith(
        'Error getting active eBird sources: Error: Database connection failed'
      );
    });

    it('should return empty array when no active sources found', async () => {
      mockDrizzleService.db.where.mockResolvedValue([]);

      const result = await service.getActiveSourcesByType('EBIRD');

      expect(result).toEqual([]);
    });
  });

  describe('getActiveSourcesByType', () => {
    it('should return active eBird sources for EBIRD type', async () => {
      const mockSources: EBirdSource[] = [
        {
          id: '550e8400-e29b-41d4-a716-446655440001',
          type: 'EBIRD',
          fetchIntervalMin: 20,
          active: true,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-01'),
          config: {
            regionName: 'San Diego County',
            regionCode: 'US-CA-SD',
          },
        },
      ];

      mockDrizzleService.db.where.mockResolvedValue(mockSources);

      const result = await service.getActiveSourcesByType('EBIRD');

      expect(result).toEqual(mockSources);
    });

    it('should throw error for unsupported source type', async () => {
      await expect(
        service.getActiveSourcesByType('UNSUPPORTED' as any)
      ).rejects.toThrow('Unsupported source type: UNSUPPORTED');
    });

    it('should propagate errors from getActiveEBirdSources', async () => {
      const error = new Error('Database error');
      mockDrizzleService.db.where.mockRejectedValue(error);

      await expect(service.getActiveSourcesByType('EBIRD')).rejects.toThrow(
        'Database error'
      );
    });
  });

  describe('edge cases', () => {
    it('should handle null/undefined database responses', async () => {
      mockDrizzleService.db.where.mockResolvedValue(null);

      const result = await service.getActiveSourcesByType('EBIRD');

      expect(result).toBeNull();
    });

    it('should handle sources with missing config data', async () => {
      const mockSourcesWithMissingConfig = [
        {
          id: '550e8400-e29b-41d4-a716-446655440001',
          type: 'EBIRD',
          fetchIntervalMin: 20,
          active: true,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-01'),
          config: {
            regionName: null,
            regionCode: 'US-CA-073',
          },
        },
      ];

      mockDrizzleService.db.where.mockResolvedValue(mockSourcesWithMissingConfig);

      const result = await service.getActiveSourcesByType('EBIRD');

      expect(result).toEqual(mockSourcesWithMissingConfig);
    });
  });
});