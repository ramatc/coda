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
import type { WebhookEvent } from "@clerk/backend";
import { verifyWebhook } from "@clerk/backend/webhooks";
import { AppModule } from "../src/app.module.js";
import { ClerkWebhookService } from "../src/auth/clerk-webhook.service.js";

// Mock the Clerk SDK's webhook verification at the module boundary — matching
// how `verifyToken` is mocked in the guard's e2e test — so no real svix
// signature needs to be crafted for these HTTP-layer tests.
vi.mock("@clerk/backend/webhooks", () => ({
  verifyWebhook: vi.fn(),
}));

const mockedVerifyWebhook = vi.mocked(verifyWebhook);

const sampleEvent = {
  type: "user.created",
  data: { id: "user_e2e" },
} as unknown as WebhookEvent;

describe("POST /webhooks/clerk (e2e)", () => {
  let app: INestApplication;
  const handleEvent = vi.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ClerkWebhookService)
      .useValue({ handleEvent })
      .compile();

    // rawBody must be enabled here too (see main.ts), otherwise
    // `req.rawBody` is undefined and the controller always 400s.
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockedVerifyWebhook.mockReset();
    handleEvent.mockReset();
  });

  it("accepts a request with a valid signature and hands the event to the service", async () => {
    mockedVerifyWebhook.mockResolvedValue(sampleEvent);

    const response = await request(app.getHttpServer())
      .post("/webhooks/clerk")
      .set("svix-id", "msg_1")
      .set("svix-timestamp", "1700000000")
      .set("svix-signature", "v1,valid")
      .send({ type: "user.created", data: { id: "user_e2e" } });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true });
    expect(handleEvent).toHaveBeenCalledWith(sampleEvent);
  });

  it("rejects a request with an invalid signature (400)", async () => {
    mockedVerifyWebhook.mockRejectedValue(new Error("invalid signature"));

    const response = await request(app.getHttpServer())
      .post("/webhooks/clerk")
      .set("svix-id", "msg_2")
      .set("svix-timestamp", "1700000000")
      .set("svix-signature", "v1,tampered")
      .send({ type: "user.created", data: { id: "user_e2e" } });

    expect(response.status).toBe(400);
    expect(handleEvent).not.toHaveBeenCalled();
  });

  it("rejects a request missing the svix signature headers (400)", async () => {
    mockedVerifyWebhook.mockRejectedValue(
      new Error("Missing required svix headers"),
    );

    const response = await request(app.getHttpServer())
      .post("/webhooks/clerk")
      .send({ type: "user.created", data: { id: "user_e2e" } });

    expect(response.status).toBe(400);
    expect(handleEvent).not.toHaveBeenCalled();
  });
});

describe("POST /webhooks/clerk (e2e) — missing CLERK_WEBHOOK_SECRET", () => {
  let app: INestApplication;
  let previousSecret: string | undefined;

  beforeAll(async () => {
    previousSecret = process.env.CLERK_WEBHOOK_SECRET;
    delete process.env.CLERK_WEBHOOK_SECRET;

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ClerkWebhookService)
      .useValue({ handleEvent: vi.fn() })
      .compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
  });

  afterAll(async () => {
    process.env.CLERK_WEBHOOK_SECRET = previousSecret;
    await app.close();
  });

  it("fails closed with 500 when the webhook secret is not configured", async () => {
    // Clear call history left over from the previous describe block's tests
    // (the mock is module-scoped) so this assertion reflects only this test.
    mockedVerifyWebhook.mockClear();

    const response = await request(app.getHttpServer())
      .post("/webhooks/clerk")
      .send({ type: "user.created", data: { id: "user_e2e" } });

    expect(response.status).toBe(500);
    expect(mockedVerifyWebhook).not.toHaveBeenCalled();
  });
});
