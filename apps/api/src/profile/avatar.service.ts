import { randomUUID } from "node:crypto";
import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  ALLOWED_AVATAR_MIME_TYPES,
  AVATAR_UPLOAD_URL_TTL_SECONDS,
  MAX_AVATAR_BYTES,
} from "./profile.constants.js";

export interface AvatarPresignRequest {
  contentType: string;
  size: number;
}

export interface AvatarPresignResult {
  /** Presigned URL the client PUTs the raw bytes to (direct to R2). */
  uploadUrl: string;
  /** Public URL the client persists via `PATCH /profile` once the PUT lands. */
  publicUrl: string;
  /** Object key under the bucket (`avatars/{userId}/{uuid}`). */
  key: string;
  /** HTTP method the client must use for `uploadUrl`. */
  method: "PUT";
  /** Seconds until `uploadUrl` expires. */
  expiresIn: number;
}

/**
 * Mints short-lived presigned PUT URLs for direct-to-R2 avatar uploads
 * (Decision #8). The API never proxies the image bytes: it only validates the
 * declared content-type/size, signs a scoped upload URL, and returns the
 * eventual public URL the client will persist. R2 is S3-compatible, so this
 * uses the standard AWS SDK S3 presigner against R2's account endpoint.
 *
 * The `S3Client` is created lazily on first use so the module boots without R2
 * credentials (matching the lazy-Prisma philosophy) — credentials are only
 * required the moment an upload URL is actually requested.
 */
@Injectable()
export class AvatarService {
  private readonly logger = new Logger(AvatarService.name);
  private s3Client: S3Client | undefined;

  constructor(private readonly config: ConfigService) {}

  /**
   * Validates the declared file metadata and returns a presigned upload URL.
   * Throws {@link BadRequestException} for a disallowed MIME type or an
   * oversized file — in that case NO URL is minted, so the caller cannot go on
   * to overwrite an existing avatar.
   */
  async createAvatarUpload(
    userId: string,
    request: AvatarPresignRequest,
  ): Promise<AvatarPresignResult> {
    // Normalized ONCE, then reused for both validation and the signed
    // ContentType — otherwise the MIME type checked against the allowlist
    // could differ in casing from what actually gets bound into the SigV4
    // signature below, and any consumer whose PUT header casing diverges
    // from its presign request would pass validation here but get an opaque
    // `SignatureDoesNotMatch` from R2 at PUT time.
    const normalizedRequest: AvatarPresignRequest = {
      ...request,
      contentType: request.contentType?.toLowerCase(),
    };
    this.assertAllowed(normalizedRequest);

    const key = `avatars/${userId}/${randomUUID()}`;
    const bucket = this.requireConfig("R2_BUCKET");
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: normalizedRequest.contentType,
      ContentLength: normalizedRequest.size,
    });

    const uploadUrl = await getSignedUrl(this.getClient(), command, {
      expiresIn: AVATAR_UPLOAD_URL_TTL_SECONDS,
      // @aws-sdk/s3-request-presigner unconditionally treats `content-type` as
      // unsignable for S3 presigned URLs (its internal `prepareRequest` always
      // adds it to `unsignableHeaders`), which drops it from `SignedHeaders`
      // entirely — R2 then accepts ANY client-supplied Content-Type on the PUT,
      // decoupled from what was declared/validated at presign time. Explicitly
      // forcing it into `signableHeaders` overrides that default and binds the
      // declared MIME type into the signature, so a PUT with a different
      // Content-Type is rejected with a signature mismatch.
      signableHeaders: new Set(["content-type"]),
    });

    return {
      uploadUrl,
      publicUrl: this.buildPublicUrl(key),
      key,
      method: "PUT",
      expiresIn: AVATAR_UPLOAD_URL_TTL_SECONDS,
    };
  }

  /** Public base URL for stored avatars (`R2_PUBLIC_BASE`), no trailing slash. */
  getPublicBase(): string {
    return this.requireConfig("R2_PUBLIC_BASE").replace(/\/+$/, "");
  }

  private buildPublicUrl(key: string): string {
    return `${this.getPublicBase()}/${key}`;
  }

  private assertAllowed(request: AvatarPresignRequest): void {
    const contentType = request.contentType?.toLowerCase();
    if (
      !contentType ||
      !ALLOWED_AVATAR_MIME_TYPES.includes(
        contentType as (typeof ALLOWED_AVATAR_MIME_TYPES)[number],
      )
    ) {
      throw new BadRequestException(
        `Unsupported avatar type. Allowed types: ${ALLOWED_AVATAR_MIME_TYPES.join(", ")}.`,
      );
    }
    if (!Number.isInteger(request.size) || request.size <= 0) {
      throw new BadRequestException("Avatar file size must be a positive integer.");
    }
    if (request.size > MAX_AVATAR_BYTES) {
      throw new BadRequestException(
        `Avatar file exceeds the ${MAX_AVATAR_BYTES}-byte limit.`,
      );
    }
  }

  private getClient(): S3Client {
    if (!this.s3Client) {
      const accountId = this.requireConfig("R2_ACCOUNT_ID");
      this.s3Client = new S3Client({
        region: "auto",
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        // Path-style keeps the bucket in the URL path against R2's account
        // endpoint instead of prepending it as a host subdomain.
        forcePathStyle: true,
        credentials: {
          accessKeyId: this.requireConfig("R2_ACCESS_KEY_ID"),
          secretAccessKey: this.requireConfig("R2_SECRET_ACCESS_KEY"),
        },
      });
    }
    return this.s3Client;
  }

  private requireConfig(key: string): string {
    const value = this.config.get<string>(key);
    if (!value) {
      this.logger.error(`${key} is not configured`);
      throw new BadRequestException(`Avatar storage is not configured (${key}).`);
    }
    return value;
  }
}
