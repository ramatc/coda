"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { buttonVariants, cn } from "@coda/ui";
import { deleteList, type ListDetail } from "../../../lib/lists";
import { HOME_PATH } from "../../../lib/onboarding";

interface DeleteListButtonProps {
  /** The list to delete: its id for the request, its title for the prompt. */
  list: Pick<ListDetail, "id" | "title">;
}

type Status = "idle" | "deleting" | "error";

/** The irreversible-action prompt, naming the list so a mis-click is obvious. */
function confirmMessage(title: string): string {
  return `Delete "${title}"? This removes the list and every album on it, and cannot be undone.`;
}

/**
 * Owner-only delete island, a sibling of `edit-list-form.tsx` on the same page:
 * one island per action, so a failing delete never disturbs an open edit draft.
 *
 * The confirmation is a plain `window.confirm`. This codebase has no dialog or
 * modal convention anywhere (the create-list flow is a full page precisely
 * because of that), and pulling in a modal library for a single destructive
 * action would be the largest dependency decision in the slice — so the platform
 * prompt stands in until a real dialog pattern exists. Dismissing it is a true
 * no-op: no request is sent and the button never enters its busy state.
 *
 * On success the owner is sent HOME rather than back to the list they just
 * deleted — there is no list index to return to, and the page they are standing
 * on is now a 404. The button deliberately stays disabled from that point on:
 * the navigation is already under way, and re-enabling would allow a second
 * delete against a list that no longer exists. On failure the API's own message
 * is surfaced inline and the button is re-enabled so a transient failure can be
 * retried.
 */
export function DeleteListButton({ list }: DeleteListButtonProps) {
  const { getToken } = useAuth();
  const router = useRouter();

  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  const deleting = status === "deleting";

  async function onDelete() {
    if (deleting || !window.confirm(confirmMessage(list.title))) {
      return;
    }

    setStatus("deleting");
    setError(null);

    try {
      const token = await getToken();
      await deleteList(token, list.id);
      // Stays in the "deleting" state on success: the navigation is already
      // under way and the list is gone, so there is nothing to re-enable for.
      router.push(HOME_PATH);
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        disabled={deleting}
        onClick={() => void onDelete()}
        className={cn(
          buttonVariants({ variant: "outline" }),
          "w-fit border-red-300 text-red-600",
          deleting && "pointer-events-none opacity-50",
        )}
      >
        {deleting ? "Deleting…" : "Delete list"}
      </button>

      {error ? (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
