import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Prisma, Profile } from "@coda/db";
import { PrismaService } from "../prisma/prisma.service.js";
import {
  extractUniqueConstraintField,
  isUniqueConstraintViolation,
} from "../prisma/prisma-error.util.js";
import {
  BIO_MAX_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_PATTERN,
} from "./profile.constants.js";

export interface ProfileResponse {
  userId: string;
  username: string;
  displayName: string;
  bio: string | null;
  avatarUrl: string | null;
  isPrivate: boolean;
}

/**
 * A profile viewed by username. Exposes only a caller-scoped `isOwnProfile`
 * boolean rather than the owner's raw `clerkUserId` — any authenticated caller
 * could otherwise harvest another user's internal Clerk id from this endpoint.
 */
export interface PublicProfileResponse extends ProfileResponse {
  isOwnProfile: boolean;
}

export interface UpdateProfileInput {
  username?: unknown;
  displayName?: unknown;
  bio?: unknown;
  avatarUrl?: unknown;
}

/**
 * Reads and edits the authenticated user's own profile (Decision #9 — the API
 * is the single data authority). `Profile.username` is `UNIQUE NOT NULL`; the
 * Clerk webhook sync (PR2) seeds it and then intentionally stops touching it, so
 * this flow owns username/displayName/bio edits without fear of a webhook
 * replay clobbering them.
 */
@Injectable()
export class ProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Resolves the local `User.id` for a Clerk user id, or throws 404. */
  async resolveUserId(clerkUserId: string): Promise<string> {
    const user = await this.prisma.client.user.findUnique({
      where: { clerkUserId },
      select: { id: true },
    });
    if (!user) {
      throw new NotFoundException("Profile not found for the current user");
    }
    return user.id;
  }

  async getOwnProfile(clerkUserId: string): Promise<ProfileResponse> {
    const user = await this.prisma.client.user.findUnique({
      where: { clerkUserId },
      include: { profile: true },
    });
    if (!user?.profile) {
      throw new NotFoundException("Profile not found for the current user");
    }
    return this.toResponse(user.profile);
  }

  async getByUsername(
    username: string,
    callerClerkUserId?: string,
  ): Promise<PublicProfileResponse> {
    const profile = await this.prisma.client.profile.findUnique({
      where: { username: this.canonicalizeUsername(username) },
      include: { user: { select: { clerkUserId: true } } },
    });
    if (!profile) {
      throw new NotFoundException(`No profile found for username ${username}`);
    }
    return {
      ...this.toResponse(profile),
      isOwnProfile: callerClerkUserId != null && callerClerkUserId === profile.user.clerkUserId,
    };
  }

  async updateOwnProfile(
    clerkUserId: string,
    input: UpdateProfileInput,
  ): Promise<ProfileResponse> {
    const userId = await this.resolveUserId(clerkUserId);
    const data = this.buildUpdateData(input);

    try {
      const profile = await this.prisma.client.profile.update({
        where: { userId },
        data,
      });
      return this.toResponse(profile);
    } catch (err) {
      if (
        isUniqueConstraintViolation(err) &&
        extractUniqueConstraintField(err) === "username"
      ) {
        throw new ConflictException(
          `Username ${String(data.username)} is already in use by another account`,
        );
      }
      throw err;
    }
  }

  private buildUpdateData(input: UpdateProfileInput): Prisma.ProfileUpdateInput {
    const data: Prisma.ProfileUpdateInput = {};

    if (input.username !== undefined) {
      data.username = this.parseUsername(input.username);
    }
    if (input.displayName !== undefined) {
      data.displayName = this.parseDisplayName(input.displayName);
    }
    if (input.bio !== undefined) {
      data.bio = this.parseBio(input.bio);
    }
    if (input.avatarUrl !== undefined) {
      data.avatarUrl = this.parseAvatarUrl(input.avatarUrl);
    }

    if (Object.keys(data).length === 0) {
      throw new BadRequestException(
        "Provide at least one of: username, displayName, bio, avatarUrl.",
      );
    }
    return data;
  }

  private parseUsername(value: unknown): string {
    if (typeof value !== "string") {
      throw new BadRequestException("username must be a string.");
    }
    const username = this.canonicalizeUsername(value.trim());
    if (
      username.length < USERNAME_MIN_LENGTH ||
      username.length > USERNAME_MAX_LENGTH ||
      !USERNAME_PATTERN.test(username)
    ) {
      throw new BadRequestException(
        `username must be ${USERNAME_MIN_LENGTH}-${USERNAME_MAX_LENGTH} characters, letters, digits or underscore only.`,
      );
    }
    return username;
  }

  /**
   * Canonicalizes a username to lowercase so "admin", "Admin" and "ADMIN"
   * cannot be registered as distinct profiles (impersonation/squatting risk)
   * and the public `/u/[username]` URL has one unambiguous casing.
   */
  private canonicalizeUsername(username: string): string {
    return username.toLowerCase();
  }

  private parseDisplayName(value: unknown): string {
    if (typeof value !== "string") {
      throw new BadRequestException("displayName must be a string.");
    }
    const displayName = value.trim();
    if (displayName.length === 0 || displayName.length > DISPLAY_NAME_MAX_LENGTH) {
      throw new BadRequestException(
        `displayName must be 1-${DISPLAY_NAME_MAX_LENGTH} characters.`,
      );
    }
    return displayName;
  }

  private parseBio(value: unknown): string | null {
    if (value === null) {
      return null;
    }
    if (typeof value !== "string") {
      throw new BadRequestException("bio must be a string or null.");
    }
    const bio = value.trim();
    if (bio.length > BIO_MAX_LENGTH) {
      throw new BadRequestException(`bio must be at most ${BIO_MAX_LENGTH} characters.`);
    }
    return bio.length === 0 ? null : bio;
  }

  private parseAvatarUrl(value: unknown): string | null {
    if (value === null) {
      return null;
    }
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new BadRequestException("avatarUrl must be a non-empty string or null.");
    }
    const avatarUrl = value.trim();
    let parsed: URL;
    try {
      parsed = new URL(avatarUrl);
    } catch {
      throw new BadRequestException("avatarUrl must be a valid URL.");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new BadRequestException("avatarUrl must be an http(s) URL.");
    }
    // Only accept URLs we could have minted ourselves — stops a client from
    // persisting an arbitrary off-site URL as their avatar. Fails CLOSED: a
    // missing/misconfigured `R2_PUBLIC_BASE` rejects every avatarUrl rather than
    // silently skipping the check.
    const publicBase = this.config.get<string>("R2_PUBLIC_BASE");
    if (!publicBase) {
      throw new BadRequestException("Avatar storage is not configured (R2_PUBLIC_BASE).");
    }
    let publicBaseUrl: URL;
    try {
      publicBaseUrl = new URL(publicBase);
    } catch {
      throw new BadRequestException("Avatar storage is misconfigured (R2_PUBLIC_BASE).");
    }
    const basePath = publicBaseUrl.pathname.replace(/\/+$/, "");
    const isSameOrigin = parsed.origin === publicBaseUrl.origin;
    const isUnderBasePath =
      basePath === "" || parsed.pathname === basePath || parsed.pathname.startsWith(`${basePath}/`);
    if (!isSameOrigin || !isUnderBasePath) {
      throw new BadRequestException(
        "avatarUrl must point to the configured avatar storage.",
      );
    }
    return avatarUrl;
  }

  private toResponse(profile: Profile): ProfileResponse {
    return {
      userId: profile.userId,
      username: profile.username,
      displayName: profile.displayName,
      bio: profile.bio,
      avatarUrl: profile.avatarUrl,
      isPrivate: profile.isPrivate,
    };
  }
}
