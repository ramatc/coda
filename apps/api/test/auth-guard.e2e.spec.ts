import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { verifyToken } from "@clerk/backend";
import { AppModule } from "../src/app.module.js";

// Mock the Clerk SDK at the module boundary so no network / real key is needed.
vi.mock("@clerk/backend", () => ({
  verifyToken: vi.fn(),
}));

const mockedVerifyToken = vi.mocked(verifyToken);

describe("ClerkGuard (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockedVerifyToken.mockReset();
  });

  it("allows a request with a valid JWT and exposes the Clerk claims", async () => {
    mockedVerifyToken.mockResolvedValue({
      sub: "user_abc123",
      sid: "sess_xyz789",
    } as Awaited<ReturnType<typeof verifyToken>>);

    const response = await request(app.getHttpServer())
      .get("/auth/me")
      .set("Authorization", "Bearer valid.jwt.token");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      clerkUserId: "user_abc123",
      sessionId: "sess_xyz789",
    });
    expect(mockedVerifyToken).toHaveBeenCalledWith(
      "valid.jwt.token",
      expect.objectContaining({ secretKey: expect.any(String) }),
    );
  });

  it("rejects a request with no Authorization header (401)", async () => {
    const response = await request(app.getHttpServer()).get("/auth/me");

    expect(response.status).toBe(401);
    expect(mockedVerifyToken).not.toHaveBeenCalled();
  });

  it("rejects a request with a malformed Authorization header (401)", async () => {
    const response = await request(app.getHttpServer())
      .get("/auth/me")
      .set("Authorization", "NotBearer token");

    expect(response.status).toBe(401);
    expect(mockedVerifyToken).not.toHaveBeenCalled();
  });

  it("rejects an expired or tampered JWT (401)", async () => {
    mockedVerifyToken.mockRejectedValue(new Error("token expired"));

    const response = await request(app.getHttpServer())
      .get("/auth/me")
      .set("Authorization", "Bearer expired.jwt.token");

    expect(response.status).toBe(401);
    expect(mockedVerifyToken).toHaveBeenCalledTimes(1);
  });

  it("leaves @Public() routes reachable without a token", async () => {
    const response = await request(app.getHttpServer()).get("/health");

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
    expect(mockedVerifyToken).not.toHaveBeenCalled();
  });
});
