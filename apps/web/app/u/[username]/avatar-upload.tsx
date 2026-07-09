"use client";

import { useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { buttonVariants, cn } from "@coda/ui";
import { getApiBaseUrl } from "../../../lib/api-client";

interface PresignResponse {
  uploadUrl: string;
  publicUrl: string;
}

type Status = "idle" | "uploading" | "error" | "done";

/**
 * Owner-only avatar upload island (client). Implements the direct-to-R2 flow
 * (Decision #8): the API only mints a presigned URL and later persists the
 * final public URL — the image bytes never pass through Nest.
 *
 *   1. POST /profile/avatar-url  → validates type/size, returns presigned PUT
 *   2. PUT <uploadUrl>           → bytes go straight to R2
 *   3. PATCH /profile            → persists the public URL as `avatarUrl`
 *   4. router.refresh()          → server re-renders with the new avatar
 */
export function AvatarUpload() {
  const { getToken } = useAuth();
  const router = useRouter();
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  async function onFileSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    setStatus("uploading");
    setError(null);

    try {
      const token = await getToken();
      const authHeaders = { Authorization: `Bearer ${token ?? ""}` };
      const base = getApiBaseUrl();

      // 1. Ask the API for a presigned upload URL (server validates type/size).
      const presignRes = await fetch(`${base}/profile/avatar-url`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ contentType: file.type, size: file.size }),
      });
      if (!presignRes.ok) {
        throw new Error(
          presignRes.status === 400
            ? "That file type or size isn't allowed."
            : "Could not start the upload.",
        );
      }
      const presign = (await presignRes.json()) as PresignResponse;

      // 2. Upload the bytes straight to R2.
      const putRes = await fetch(presign.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!putRes.ok) {
        throw new Error("Upload to storage failed.");
      }

      // 3. Persist the final public URL on the profile.
      const patchRes = await fetch(`${base}/profile`, {
        method: "PATCH",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ avatarUrl: presign.publicUrl }),
      });
      if (!patchRes.ok) {
        throw new Error("Could not save the new avatar.");
      }

      setStatus("done");
      router.refresh();
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <label
        className={cn(
          buttonVariants({ variant: "outline" }),
          "w-fit cursor-pointer",
          status === "uploading" && "pointer-events-none opacity-50",
        )}
      >
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={onFileSelected}
          disabled={status === "uploading"}
        />
        {status === "uploading" ? "Uploading…" : "Change avatar"}
      </label>
      {status === "error" && error ? (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
