import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { RecommendationStatus } from "@coda/db";
import { RecommendationsService } from "../src/recommendations/recommendations.service.js";
import type { RecoGenerationService } from "../src/recommendations/reco-generation.service.js";
import type { PrismaService } from "../src/prisma/prisma.service.js";

const CLERK_ID = "clerk_1";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
const REC_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const REC_2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const OTHER_REC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9";

interface RecoRow {
  id: string;
  userId: string;
  score: number;
  reason: unknown;
  status: RecommendationStatus;
  generatedAt: Date;
  album: {
    id: string;
    title: string;
    coverUrl: string | null;
    releaseDate: Date | null;
    primaryArtist: { name: string };
  };
}

/**
 * In-memory Prisma stand-in for {@link RecommendationsService}: `user.findUnique`
 * by clerk id, `recommendation.findMany` (ACTIVE, score-ordered, with the album
 * relation), and `recommendation.updateMany` (the dismiss flip scoped to the
 * caller). Proves the read/dismiss surface without a live Postgres.
 */
function createFakePrisma() {
  const users = new Map<string, string>();
  const recos: RecoRow[] = [];

  const client = {
    user: {
      findUnique: async (args: { where: { clerkUserId: string } }) => {
        const id = users.get(args.where.clerkUserId);
        return id ? { id } : null;
      },
    },
    recommendation: {
      findMany: async (args: {
        where: { userId: string; status: RecommendationStatus };
      }) =>
        recos
          .filter(
            (r) =>
              r.userId === args.where.userId && r.status === args.where.status,
          )
          .sort((a, b) => b.score - a.score),
      updateMany: async (args: {
        where: { id: string; userId: string };
        data: { status: RecommendationStatus; dismissedAt: Date };
      }) => {
        let count = 0;
        for (const row of recos) {
          if (row.id === args.where.id && row.userId === args.where.userId) {
            row.status = args.data.status;
            count += 1;
          }
        }
        return { count };
      },
    },
  };

  return { prisma: { client } as unknown as PrismaService, users, recos };
}

function pushReco(
  fake: ReturnType<typeof createFakePrisma>,
  overrides: Partial<RecoRow> & Pick<RecoRow, "id" | "score">,
): void {
  fake.recos.push({
    userId: USER_ID,
    reason: { topGenre: "Rock", matchedArtist: true },
    status: RecommendationStatus.ACTIVE,
    generatedAt: new Date("2026-07-01T00:00:00.000Z"),
    album: {
      id: "album-1",
      title: "OK Computer",
      coverUrl: null,
      releaseDate: new Date("1997-06-16T00:00:00.000Z"),
      primaryArtist: { name: "Radiohead" },
    },
    ...overrides,
  });
}

describe("RecommendationsService", () => {
  let fake: ReturnType<typeof createFakePrisma>;
  let generation: { generateForUser: ReturnType<typeof vi.fn> };
  let service: RecommendationsService;

  beforeEach(() => {
    fake = createFakePrisma();
    generation = { generateForUser: vi.fn().mockResolvedValue({ generated: 0, pruned: 0 }) };
    service = new RecommendationsService(
      fake.prisma,
      generation as unknown as RecoGenerationService,
    );
    fake.users.set(CLERK_ID, USER_ID);
  });

  it("returns the caller's ACTIVE recommendations, strongest score first", async () => {
    pushReco(fake, { id: REC_1, score: 0.4 });
    pushReco(fake, { id: REC_2, score: 0.9 });

    const items = await service.getRecommendations(CLERK_ID);

    expect(items.map((i) => i.id)).toEqual([REC_2, REC_1]);
    expect(items[0].album.releaseYear).toBe(1997);
    expect(items[0].album.primaryArtistName).toBe("Radiohead");
    expect(items[0].reason).toEqual({ topGenre: "Rock", matchedArtist: true });
    // Recommendations already existed → no cold-read generation triggered.
    expect(generation.generateForUser).not.toHaveBeenCalled();
  });

  it("degrades to an empty list (no generation) when the local user is unsynced", async () => {
    fake.users.clear();

    const items = await service.getRecommendations(CLERK_ID);

    expect(items).toEqual([]);
    expect(generation.generateForUser).not.toHaveBeenCalled();
  });

  it("generates synchronously on a cold read (no ACTIVE rows yet) then returns them", async () => {
    generation.generateForUser.mockImplementation(async () => {
      pushReco(fake, { id: REC_1, score: 0.7 });
      return { generated: 1, pruned: 0 };
    });

    const items = await service.getRecommendations(CLERK_ID);

    expect(generation.generateForUser).toHaveBeenCalledWith(USER_ID);
    expect(items.map((i) => i.id)).toEqual([REC_1]);
  });

  it("dismisses one of the caller's own recommendations", async () => {
    pushReco(fake, { id: REC_1, score: 0.7 });

    const result = await service.dismiss(CLERK_ID, REC_1);

    expect(result).toEqual({ id: REC_1, status: RecommendationStatus.DISMISSED });
    expect(fake.recos[0].status).toBe(RecommendationStatus.DISMISSED);
  });

  it("404s when dismissing another user's recommendation (never leaks it)", async () => {
    pushReco(fake, { id: OTHER_REC, score: 0.7, userId: OTHER_USER_ID });

    await expect(service.dismiss(CLERK_ID, OTHER_REC)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // The other user's row is untouched.
    expect(fake.recos[0].status).toBe(RecommendationStatus.ACTIVE);
  });

  it("404s when dismissing an unknown recommendation id", async () => {
    await expect(
      service.dismiss(CLERK_ID, "99999999-9999-4999-8999-999999999999"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("404s the dismiss write when the local user is unsynced", async () => {
    fake.users.clear();

    await expect(service.dismiss(CLERK_ID, REC_1)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("rejects a malformed recommendation id with a 400", async () => {
    await expect(service.dismiss(CLERK_ID, "not-a-uuid")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
