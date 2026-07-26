"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { buttonVariants, cn } from "@coda/ui";
import { updateList, type ListDetail, type UpdateListInput } from "../../../lib/lists";

/** The list fields this form edits — everything `PATCH /lists/:id` accepts. */
type EditableList = Pick<
  ListDetail,
  "id" | "title" | "description" | "isRanked" | "isPublic"
>;

interface EditListFormProps {
  /** The list as the server last rendered it: both the seed and the baseline. */
  list: EditableList;
}

type Status = "idle" | "saving" | "error";

/** The form's live values, mirroring {@link EditableList} minus the id. */
interface Draft {
  title: string;
  description: string;
  isRanked: boolean;
  isPublic: boolean;
}

/** Seeds a draft from the list's current server values. */
function draftFrom(list: EditableList): Draft {
  return {
    title: list.title,
    description: list.description ?? "",
    isRanked: list.isRanked,
    isPublic: list.isPublic,
  };
}

/**
 * The patch for `PATCH /lists/:id`: ONLY the fields whose normalized draft value
 * differs from the list's current one, matching the API's partial-patch
 * contract. Both text fields are normalized exactly as the service normalizes
 * them (title trimmed, a blank description collapsed to `null`) so the
 * comparison never reports a change the server would discard.
 *
 * An empty result means nothing changed — the API answers 400 ("No fields to
 * update.") for an empty patch, so the caller keeps save disabled instead.
 */
function buildListPatch(list: EditableList, draft: Draft): UpdateListInput {
  const patch: UpdateListInput = {};

  const title = draft.title.trim();
  if (title !== list.title) {
    patch.title = title;
  }

  const trimmedDescription = draft.description.trim();
  const description = trimmedDescription.length > 0 ? trimmedDescription : null;
  if (description !== list.description) {
    patch.description = description;
  }

  if (draft.isRanked !== list.isRanked) {
    patch.isRanked = draft.isRanked;
  }
  if (draft.isPublic !== list.isPublic) {
    patch.isPublic = draft.isPublic;
  }

  return patch;
}

/**
 * Owner-only edit island for a list's title, description and flags. A separate
 * client island rather than stateful logic inside the server-adjacent
 * {@link import("./list-detail").ListDetailView}, following the same split as
 * `create-list-form.tsx` and the reorder island: the server page owns the fetch
 * and the ownership decision, the island owns the form state.
 *
 * Collapsed to a single trigger by default — a list page is for reading the
 * list, so the form only takes over the header once the owner asks for it, and
 * every open re-seeds from the latest server props (there is no long-lived local
 * copy that a `router.refresh()` could leave stale).
 *
 * Save sends ONLY the changed fields and stays disabled until there is at least
 * one, so the API's empty-patch 400 is unreachable rather than merely handled.
 * On success it `router.refresh()`es — the same server-authoritative pattern as
 * `AlbumActions.run` — and collapses. On failure the API's own message is shown
 * inline and the edits survive, so the owner can correct and retry.
 */
export function EditListForm({ list }: EditListFormProps) {
  const { getToken } = useAuth();
  const router = useRouter();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(list));
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  const saving = status === "saving";
  const patch = buildListPatch(list, draft);
  const submittable =
    !saving && draft.title.trim().length > 0 && Object.keys(patch).length > 0;

  /** Opens the form on a draft freshly seeded from the current server props. */
  function open() {
    setDraft(draftFrom(list));
    setStatus("idle");
    setError(null);
    setEditing(true);
  }

  /** Collapses the form, discarding the draft (the next open re-seeds it). */
  function cancel() {
    setEditing(false);
    setStatus("idle");
    setError(null);
  }

  /** Applies one field to the draft, leaving the rest untouched. */
  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!submittable) {
      return;
    }

    setStatus("saving");
    setError(null);

    try {
      const token = await getToken();
      await updateList(token, list.id, patch);
      setStatus("idle");
      setEditing(false);
      // The server page re-reads the list, so the header re-renders from the
      // saved values rather than from this island's local draft.
      router.refresh();
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={open}
        className={cn(buttonVariants({ variant: "outline" }), "w-fit")}
      >
        Edit list
      </button>
    );
  }

  return (
    <form
      onSubmit={(event) => void onSubmit(event)}
      className="flex w-full flex-col gap-4 rounded-card border border-brand-100 p-4"
    >
      {error ? (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        <label htmlFor="edit-list-title" className="text-sm opacity-70">
          Title
        </label>
        <input
          id="edit-list-title"
          type="text"
          value={draft.title}
          disabled={saving}
          onChange={(event) => update("title", event.target.value)}
          className="rounded-card border border-brand-200 px-3 py-2"
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="edit-list-description" className="text-sm opacity-70">
          Description
        </label>
        <textarea
          id="edit-list-description"
          value={draft.description}
          disabled={saving}
          onChange={(event) => update("description", event.target.value)}
          placeholder="What ties these albums together?"
          rows={4}
          className="rounded-card border border-brand-200 px-3 py-2 text-sm"
        />
      </div>

      <div className="flex flex-col gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.isRanked}
            disabled={saving}
            onChange={(event) => update("isRanked", event.target.checked)}
          />
          <span>Ranked list</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.isPublic}
            disabled={saving}
            onChange={(event) => update("isPublic", event.target.checked)}
          />
          <span>Visible to everyone</span>
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={!submittable}
          className={cn(
            buttonVariants(),
            "w-fit",
            !submittable && "pointer-events-none opacity-50",
          )}
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
        <button
          type="button"
          onClick={cancel}
          disabled={saving}
          className={cn(buttonVariants({ variant: "outline" }), "w-fit")}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
