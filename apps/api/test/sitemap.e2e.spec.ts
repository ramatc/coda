import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { sitemapEntriesSchema } from "@coda/types";
import { AppModule } from "../src/app.module.js";
import { PrismaService } from "../src/prisma/prisma.service.js";

// Mock the Clerk SDK at the module boundary so no network / real key is needed
// (matches lists.e2e / reviews.e2e).
vi.mock("@clerk/backend", () => ({ verifyToken: vi.fn() }));

const ALBUM_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PUBLIC_LIST_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PRIVATE_LIST_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const ALBUM_ROWS = [
  { id: ALBUM_ID, updatedAt: new Date("2026-10-01T08:00:00.000Z") },
];

const LIST_ROWS = [
  {
    id: PUBLIC_LIST_ID,
    isPublic: true,
    updatedAt: new Date("2026-10-03T10:00:00.000Z"),
  },
  {
    id: PRIVATE_LIST_ID,
    isPublic: false,
    updatedAt: new Date("2026-10-04T10:00:00.000Z"),
  },
];

/** Applies the `isPublic` filter the way Postgres would. */
const prismaStub = {
  client: {
    album: { findMany: async () => ALBUM_ROWS },
    list: {
      findMany: async (args: { where?: { isPublic?: boolean } }) =>
        LIST_ROWS.filter(
          (row) =>
            args.where?.isPublic === undefined ||
            row.isPublic === args.where.isPublic,
        ).map(({ id, updatedAt }) => ({ id, updatedAt })),
    },
  },
};

describe("GET /sitemap (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prismaStub)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("answers an anonymous caller with the albums and the public lists", async () => {
    const response = await request(app.getHttpServer()).get("/sitemap");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      albums: [{ id: ALBUM_ID, updatedAt: "2026-10-01T08:00:00.000Z" }],
      lists: [{ id: PUBLIC_LIST_ID, updatedAt: "2026-10-03T10:00:00.000Z" }],
    });
    expect(sitemapEntriesSchema.safeParse(response.body).success).toBe(true);
  });

  it("never includes a private list", async () => {
    const response = await request(app.getHttpServer()).get("/sitemap");

    expect(JSON.stringify(response.body)).not.toContain(PRIVATE_LIST_ID);
  });
});
