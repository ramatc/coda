/**
 * Avatar upload constraints, enforced by the presign endpoint BEFORE any URL is
 * minted. Rejecting an oversized or disallowed file here (rather than after the
 * bytes reach R2) is what keeps a user's prior avatar untouched when they pick
 * an invalid file — the flow never reaches the `PATCH /profile` that would
 * overwrite `avatarUrl`.
 */

/** MIME types accepted for an avatar image. */
export const ALLOWED_AVATAR_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

/** Maximum avatar object size in bytes (5 MiB). */
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

/** How long a minted avatar upload URL stays valid, in seconds. */
export const AVATAR_UPLOAD_URL_TTL_SECONDS = 60;

/** Profile free-text field bounds. */
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 30;
/** Allowed username characters: letters, digits, underscore. */
export const USERNAME_PATTERN = /^[a-zA-Z0-9_]+$/;
export const DISPLAY_NAME_MAX_LENGTH = 50;
export const BIO_MAX_LENGTH = 500;
