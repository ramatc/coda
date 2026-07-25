"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { buttonVariants, cn } from "@coda/ui";
import { createList } from "../../../lib/lists";

type Status = "idle" | "submitting" | "error";

/**
 * Create-list form (client island). A full page rather than a modal: the
 * codebase has no modal pattern, and this mirrors `/onboarding`'s server
 * page + client island split, where the page owns the auth/onboarding gate and
 * the island owns the form state.
 *
 * The defaults match the API's own (`isRanked: false`, `isPublic: true`), and a
 * blank description collapses to `null` exactly as the service normalizes it, so
 * the payload never depends on which side trims first. The API remains the real
 * validation authority — its message is surfaced verbatim on failure, and the
 * form stays usable so the user can correct and retry rather than losing input.
 */
export function CreateListForm() {
  const { getToken } = useAuth();
  const router = useRouter();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [isRanked, setIsRanked] = useState(false);
  const [isPublic, setIsPublic] = useState(true);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  const trimmedTitle = title.trim();
  const submitting = status === "submitting";
  const submittable = trimmedTitle.length > 0 && !submitting;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!submittable) {
      return;
    }

    setStatus("submitting");
    setError(null);

    try {
      const token = await getToken();
      const trimmedDescription = description.trim();
      const list = await createList(token, {
        title: trimmedTitle,
        description: trimmedDescription.length > 0 ? trimmedDescription : null,
        isRanked,
        isPublic,
      });
      // Deliberately stays in the "submitting" state on success: the navigation
      // is already under way, and re-enabling the button first would allow a
      // second submit that creates a duplicate list.
      router.push(`/lists/${list.id}`);
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-8 px-6 py-12">
      <header>
        <h1 className="text-3xl font-semibold text-brand-600">New list</h1>
        <p className="mt-2 text-base opacity-70">
          Give your list a name — you can add albums once it exists.
        </p>
      </header>

      {error ? (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}

      <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <label htmlFor="list-title" className="text-sm opacity-70">
            Title
          </label>
          <input
            id="list-title"
            type="text"
            value={title}
            disabled={submitting}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Best of 2026"
            className="rounded-card border border-brand-200 px-3 py-2"
          />
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="list-description" className="text-sm opacity-70">
            Description
          </label>
          <textarea
            id="list-description"
            value={description}
            disabled={submitting}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What ties these albums together?"
            rows={4}
            className="rounded-card border border-brand-200 px-3 py-2 text-sm"
          />
        </div>

        <div className="flex flex-col gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isRanked}
              disabled={submitting}
              onChange={(event) => setIsRanked(event.target.checked)}
            />
            <span>Ranked list</span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isPublic}
              disabled={submitting}
              onChange={(event) => setIsPublic(event.target.checked)}
            />
            <span>Visible to everyone</span>
          </label>
        </div>

        <button
          type="submit"
          disabled={!submittable}
          className={cn(
            buttonVariants(),
            "w-fit",
            !submittable && "pointer-events-none opacity-50",
          )}
        >
          {submitting ? "Creating…" : "Create list"}
        </button>
      </form>
    </main>
  );
}
