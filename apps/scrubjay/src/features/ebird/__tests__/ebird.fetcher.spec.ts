import { ConfigService } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { EBirdFetcher } from "../ebird.fetcher";

describe("EBirdFetcher", () => {
  let fetcher: EBirdFetcher;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [EBirdFetcher, ConfigService],
    }).compile();
    fetcher = module.get<EBirdFetcher>(EBirdFetcher);
  });

  it("should be defined", () => {
    expect(fetcher).toBeDefined();
  });
});
