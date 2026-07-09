import { beforeEach, describe, expect, it } from "vitest";
import { BadRequestException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { AvatarService } from "../src/profile/avatar.service.js";
import { MAX_AVATAR_BYTES } from "../src/profile/profile.constants.js";

/**
 * Fake ConfigService returning placeholder R2 credentials. The presigner only
 * needs *some* credentials to compute a signature — it never reaches R2 — so a
 * well-formed URL is produced deterministically without real secrets, matching
 * the no-live-infra sandbox convention (PR1/PR2).
 */
const R2_CONFIG: Record<string, string> = {
  R2_ACCOUNT_ID: "test_account_123",
  R2_ACCESS_KEY_ID: "test_access_key",
  R2_SECRET_ACCESS_KEY: "test_secret_key",
  R2_BUCKET: "coda-avatars",
  R2_PUBLIC_BASE: "https://cdn.coda.test/avatars",
};

function fakeConfig(overrides: Record<string, string> = {}): ConfigService {
  const map = { ...R2_CONFIG, ...overrides };
  return {
    get: (key: string) => map[key],
  } as unknown as ConfigService;
}

describe("AvatarService", () => {
  let service: AvatarService;

  beforeEach(() => {
    service = new AvatarService(fakeConfig());
  });

  it("mints a well-formed presigned R2 PUT URL for a valid image", async () => {
    const result = await service.createAvatarUpload("user_local_1", {
      contentType: "image/png",
      size: 100_000,
    });

    const url = new URL(result.uploadUrl);
    // R2 S3-compatible endpoint derived from the account id.
    expect(url.host).toBe("test_account_123.r2.cloudflarestorage.com");
    // Object key namespaced under the user, with a random suffix.
    expect(result.key).toMatch(/^avatars\/user_local_1\/[0-9a-f-]{36}$/);
    expect(url.pathname).toContain(`/coda-avatars/${result.key}`);
    // SigV4 query params prove it was actually signed.
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
    expect(url.searchParams.get("X-Amz-Expires")).toBe("60");
    // The declared MIME type must be bound into the signature (not just
    // hoisted to a query param) — otherwise a client could PUT with a
    // different Content-Type than what it declared/was validated at presign
    // time, and R2 would store+serve it under the attacker-chosen type.
    const signedHeaders = url.searchParams.get("X-Amz-SignedHeaders");
    expect(signedHeaders).toContain("content-type");
    expect(signedHeaders).toContain("content-length");
    // Public URL the client will persist via PATCH /profile.
    expect(result.publicUrl).toBe(
      `https://cdn.coda.test/avatars/${result.key}`,
    );
    expect(result.method).toBe("PUT");
  });

  it("rejects a disallowed MIME type without minting a URL", async () => {
    await expect(
      service.createAvatarUpload("user_local_1", {
        contentType: "application/pdf",
        size: 100_000,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects a file exceeding the size limit without minting a URL", async () => {
    await expect(
      service.createAvatarUpload("user_local_1", {
        contentType: "image/jpeg",
        size: MAX_AVATAR_BYTES + 1,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects a non-positive size", async () => {
    await expect(
      service.createAvatarUpload("user_local_1", {
        contentType: "image/webp",
        size: 0,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
