"use server";

import { auth } from "@clerk/nextjs/server";
import { getApiBaseUrl } from "../../lib/api-client";

export interface CompleteOnboardingArgs {
  genreSlugs: string[];
  artistIds: string[];
  albumIds: string[];
}

export type CompleteOnboardingResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Server Action that submits the onboarding selection to the API with the
 * user's Clerk token (Decision #9 — mutations go through the guarded API, never
 * the DB directly). On success the client wizard navigates to `/home`; the API
 * enforces the real ≥3 genres / ≥1 artist rules, so a 400 is surfaced back as a
 * validation message rather than trusting the client alone.
 */
export async function completeOnboarding(
  args: CompleteOnboardingArgs,
): Promise<CompleteOnboardingResult> {
  const { getToken } = await auth();
  const token = await getToken();

  let response: Response;
  try {
    response = await fetch(`${getApiBaseUrl()}/onboarding/complete`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token ?? ""}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    });
  } catch {
    return { ok: false, error: "Could not save your onboarding. Please retry." };
  }

  if (response.ok) {
    return { ok: true };
  }

  // Any non-2xx response (400 validation, 409 conflict, etc.) may carry a
  // Nest exception body with a specific `message` — read it generically
  // rather than special-casing one status code, so a 409's conflict-field
  // message (e.g. from `extractUniqueConstraintField`) isn't discarded in
  // favor of the generic fallback below.
  const body = (await response.json().catch(() => null)) as
    | { message?: string | string[] }
    | null;
  const message = Array.isArray(body?.message)
    ? body?.message.join(" ")
    : body?.message;
  if (message) {
    return { ok: false, error: message };
  }

  return { ok: false, error: "Could not save your onboarding. Please retry." };
}
