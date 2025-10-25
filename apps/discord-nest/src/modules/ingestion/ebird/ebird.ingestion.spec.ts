import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EBirdIngestionService } from './ebird.ingestion';
import { DrizzleService } from '@/core/drizzle/drizzle.service';
import { EBirdSource } from '../../sources/sources.schema';
import { EBirdObservation, EBirdObservationWithMediaCounts } from './ebird.schema';
import { observations, locations } from '@/core/drizzle/drizzle.schema';

// Mock fetch globally
global.fetch = jest.fn();

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

describe('EBirdIngestionService', () => {
  let service: EBirdIngestionService;
  let drizzleService: DrizzleService;
  let configService: ConfigService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
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

    service = module.get<EBirdIngestionService>(EBirdIngestionService);
    drizzleService = module.get<DrizzleService>(DrizzleService);
    configService = module.get<ConfigService>(ConfigService);

    // Reset mocks
    jest.clearAllMocks();
    (global.fetch as jest.Mock).mockClear();
  });

  describe('fetchObservations', () => {
    const mockSource: EBirdSource = {
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
    };

    beforeEach(() => {
      process.env.EBIRD_BASE_URL = 'https://api.ebird.org';
      mockConfigService.get.mockReturnValue('test-api-key');
    });

    it('should fetch observations successfully', async () => {
      const mockObservations: EBirdObservation[] = [
        {
          speciesCode: 'amrrob',
          comName: 'American Robin',
          sciName: 'Turdus migratorius',
          locId: 'L123456',
          locName: 'Test Location',
          obsDt: '2024-01-01 10:00:00',
          howMany: 2,
          lat: 32.7157,
          lng: -117.1611,
          obsValid: true,
          obsReviewed: true,
          locationPrivate: false,
          subId: 'S123456',
          subnational2Code: 'US-CA-073',
          subnational2Name: 'San Diego',
          subnational1Code: 'US-CA',
          subnational1Name: 'California',
          countryCode: 'US',
          countryName: 'United States',
          userDisplayName: 'Test User',
          obsId: 'O123456',
          checklistId: 'C123456',
          presenceNoted: false,
          hasComments: false,
          evidence: 'P',
          firstName: 'Test',
          lastName: 'User',
          hasRichMedia: true,
        },
      ];

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValueOnce(mockObservations),
      });

      const result = await (service as any).fetchObservations('US-CA-073');

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.ebird.org/v2/data/obs/US-CA-073/recent/notable?detail=full&back=7',
        {
          headers: { 'X-eBirdApiKey': 'test-api-key' },
        }
      );
      expect(result).toEqual(mockObservations);
    });

    it('should return empty array when no observations', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValueOnce([]),
      });

      const result = await (service as any).fetchObservations('US-CA-073');

      expect(result).toEqual([]);
    });

    it('should filter out invalid observations', async () => {
      const invalidObservations = [
        { invalid: 'data' },
        {
          speciesCode: 'amrrob',
          comName: 'American Robin',
          sciName: 'Turdus migratorius',
          locId: 'L123456',
          locName: 'Test Location',
          obsDt: '2024-01-01 10:00:00',
          lat: 32.7157,
          lng: -117.1611,
          obsValid: true,
          obsReviewed: true,
          locationPrivate: false,
          subId: 'S123456',
          subnational2Code: 'US-CA-073',
          subnational2Name: 'San Diego',
          subnational1Code: 'US-CA',
          subnational1Name: 'California',
          countryCode: 'US',
          countryName: 'United States',
          obsId: 'O123456',
          checklistId: 'C123456',
          presenceNoted: false,
          hasComments: false,
          hasRichMedia: true,
        },
      ];

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValueOnce(invalidObservations),
      });

      const loggerSpy = jest.spyOn(service['logger'], 'error');

      const result = await (service as any).fetchObservations('US-CA-073');

      expect(result).toHaveLength(1);
      expect(loggerSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid observation:')
      );
    });

    it('should throw error when fetch fails', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        statusText: 'Not Found',
      });

      await expect((service as any).fetchObservations('US-CA-073')).rejects.toThrow(
        'Failed to fetch observations: Not Found'
      );
    });
  });

  describe('groupObservationsForInsert', () => {
    it('should group observations by speciesCode and subId', () => {
      const observations: EBirdObservation[] = [
        {
          speciesCode: 'amrrob',
          subId: 'S123456',
          evidence: 'P',
        } as EBirdObservation,
        {
          speciesCode: 'amrrob',
          subId: 'S123456',
          evidence: 'A',
        } as EBirdObservation,
        {
          speciesCode: 'amrrob',
          subId: 'S123456',
          evidence: 'V',
        } as EBirdObservation,
        {
          speciesCode: 'amrrob',
          subId: 'S123457',
          evidence: 'P',
        } as EBirdObservation,
      ];

      const result = (service as any).groupObservationsForInsert(observations);

      expect(result).toHaveLength(2);
      expect(result[0].photos).toBe(1);
      expect(result[0].audio).toBe(1);
      expect(result[0].video).toBe(1);
      expect(result[1].photos).toBe(1);
      expect(result[1].audio).toBe(0);
      expect(result[1].video).toBe(0);
    });

    it('should handle observations without evidence', () => {
      const observations: EBirdObservation[] = [
        {
          speciesCode: 'amrrob',
          subId: 'S123456',
          evidence: null,
        } as EBirdObservation,
      ];

      const result = (service as any).groupObservationsForInsert(observations);

      expect(result).toHaveLength(1);
      expect(result[0].photos).toBe(0);
      expect(result[0].audio).toBe(0);
      expect(result[0].video).toBe(0);
    });
  });

  describe('upsertLocations', () => {
    it('should upsert locations in batches', async () => {
      const observations: EBirdObservation[] = [
        {
          locId: 'L123456',
          subnational2Name: 'San Diego',
          subnational2Code: 'US-CA-073',
          subnational1Name: 'California',
          subnational1Code: 'US-CA',
          locName: 'Test Location',
          lat: 32.7157,
          lng: -117.1611,
          locationPrivate: false,
        } as EBirdObservation,
      ];

      mockDrizzleService.db.insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
        }),
      });

      await (service as any).upsertLocations(observations);

      expect(mockDrizzleService.db.insert).toHaveBeenCalledWith(locations);
    });

    it('should handle large batches by splitting them', async () => {
      // Create 250 observations to test batching
      const observations = Array.from({ length: 250 }, (_, i) => ({
        locId: `L${i}`,
        subnational2Name: 'San Diego',
        subnational2Code: 'US-CA-073',
        subnational1Name: 'California',
        subnational1Code: 'US-CA',
        locName: `Test Location ${i}`,
        lat: 32.7157,
        lng: -117.1611,
        locationPrivate: false,
      })) as EBirdObservation[];

      mockDrizzleService.db.insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
        }),
      });

      await (service as any).upsertLocations(observations);

      // Should be called 3 times (100 + 100 + 50)
      expect(mockDrizzleService.db.insert).toHaveBeenCalledTimes(3);
    });
  });

  describe('upsertObservations', () => {
    it('should upsert observations in batches', async () => {
      const observations: EBirdObservationWithMediaCounts[] = [
        {
          speciesCode: 'amrrob',
          subId: 'S123456',
          comName: 'American Robin',
          sciName: 'Turdus migratorius',
          locId: 'L123456',
          obsDt: '2024-01-01 10:00:00',
          howMany: 2,
          obsValid: true,
          obsReviewed: true,
          presenceNoted: false,
          photos: 1,
          audio: 0,
          video: 0,
          hasComments: false,
        } as EBirdObservationWithMediaCounts,
      ];

      mockDrizzleService.db.insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
        }),
      });

      await (service as any).upsertObservations(observations);

      expect(mockDrizzleService.db.insert).toHaveBeenCalled();
    });

    it('should handle observations with undefined howMany', () => {
      const observations: EBirdObservationWithMediaCounts[] = [
        {
          speciesCode: 'amrrob',
          subId: 'S123456',
          comName: 'American Robin',
          sciName: 'Turdus migratorius',
          locId: 'L123456',
          obsDt: '2024-01-01 10:00:00',
          howMany: undefined,
          obsValid: true,
          obsReviewed: true,
          presenceNoted: false,
          photos: 1,
          audio: 0,
          video: 0,
          hasComments: false,
        } as EBirdObservationWithMediaCounts,
      ];

      const result = (service as any).upsertObservations(observations);

      expect(mockDrizzleService.db.insert).toHaveBeenCalled();
    });
  });

  describe('ingest', () => {
    const mockSource: EBirdSource = {
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
    };

    beforeEach(() => {
      process.env.EBIRD_BASE_URL = 'https://api.ebird.org';
      mockConfigService.get.mockReturnValue('test-api-key');
    });

    it('should complete ingestion successfully', async () => {
      const mockObservations: EBirdObservation[] = [
        {
          speciesCode: 'amrrob',
          comName: 'American Robin',
          sciName: 'Turdus migratorius',
          locId: 'L123456',
          locName: 'Test Location',
          obsDt: '2024-01-01 10:00:00',
          howMany: 2,
          lat: 32.7157,
          lng: -117.1611,
          obsValid: true,
          obsReviewed: true,
          locationPrivate: false,
          subId: 'S123456',
          subnational2Code: 'US-CA-073',
          subnational2Name: 'San Diego',
          subnational1Code: 'US-CA',
          subnational1Name: 'California',
          countryCode: 'US',
          countryName: 'United States',
          userDisplayName: 'Test User',
          obsId: 'O123456',
          checklistId: 'C123456',
          presenceNoted: false,
          hasComments: false,
          evidence: 'P',
          firstName: 'Test',
          lastName: 'User',
          hasRichMedia: true,
        },
      ];

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValueOnce(mockObservations),
      });

      mockDrizzleService.db.insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
        }),
      });

      await service.ingest(mockSource);

      expect(global.fetch).toHaveBeenCalled();
      expect(mockDrizzleService.db.insert).toHaveBeenCalledTimes(2); // locations + observations
    });

    it('should handle errors and log them', async () => {
      const error = new Error('Network error');
      (global.fetch as jest.Mock).mockRejectedValueOnce(error);

      const loggerSpy = jest.spyOn(service['logger'], 'error');

      await expect(service.ingest(mockSource)).rejects.toThrow('Network error');

      expect(loggerSpy).toHaveBeenCalledWith(
        `Error ingesting eBird data for source ${mockSource.id}: Error: Network error`
      );
    });

    it('should handle empty observations', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValueOnce([]),
      });

      await service.ingest(mockSource);

      expect(global.fetch).toHaveBeenCalled();
      expect(mockDrizzleService.db.insert).not.toHaveBeenCalled();
    });
  });

  describe('edge cases', () => {
    it('should handle missing EBIRD_TOKEN', async () => {
      mockConfigService.get.mockReturnValue(undefined);

      await expect((service as any).fetchObservations('US-CA-073')).rejects.toThrow();
    });

    it('should handle missing EBIRD_BASE_URL', async () => {
      delete process.env.EBIRD_BASE_URL;
      mockConfigService.get.mockReturnValue('test-api-key');

      await expect((service as any).fetchObservations('US-CA-073')).rejects.toThrow();
    });

    it('should handle database errors during upsert', async () => {
      const mockSource: EBirdSource = {
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
      };

      process.env.EBIRD_BASE_URL = 'https://api.ebird.org';
      mockConfigService.get.mockReturnValue('test-api-key');

      const mockObservations: EBirdObservation[] = [
        {
          speciesCode: 'amrrob',
          comName: 'American Robin',
          sciName: 'Turdus migratorius',
          locId: 'L123456',
          locName: 'Test Location',
          obsDt: '2024-01-01 10:00:00',
          lat: 32.7157,
          lng: -117.1611,
          obsValid: true,
          obsReviewed: true,
          locationPrivate: false,
          subId: 'S123456',
          subnational2Code: 'US-CA-073',
          subnational2Name: 'San Diego',
          subnational1Code: 'US-CA',
          subnational1Name: 'California',
          countryCode: 'US',
          countryName: 'United States',
          userDisplayName: 'Test User',
          obsId: 'O123456',
          checklistId: 'C123456',
          presenceNoted: false,
          hasComments: false,
          firstName: 'Test',
          lastName: 'User',
          hasRichMedia: true,
        },
      ];

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValueOnce(mockObservations),
      });

      const dbError = new Error('Database connection failed');
      mockDrizzleService.db.insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoUpdate: jest.fn().mockRejectedValue(dbError),
        }),
      });

      const loggerSpy = jest.spyOn(service['logger'], 'error');

      await expect(service.ingest(mockSource)).rejects.toThrow('Database connection failed');

      expect(loggerSpy).toHaveBeenCalledWith(
        `Error ingesting eBird data for source ${mockSource.id}: Error: Database connection failed`
      );
    });
  });
});
