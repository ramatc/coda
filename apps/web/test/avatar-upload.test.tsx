// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { AvatarUpload } from "../app/u/[username]/avatar-upload";

/**
 * Component tests for the owner-only avatar upload island. The direct-to-R2
 * flow is three sequential `fetch` calls (presign → PUT bytes → PATCH profile)
 * followed by a `router.refresh()`, so the whole flow is driven here through a
 * stubbed `fetch` that answers each leg in order.
 */

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: vi.fn().mockResolvedValue("test-token") }),
}));

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

const fetchMock = vi.fn();

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  refreshMock.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

/** A minimal `Response`-shaped stub — the island reads only these two. */
function ok(body: unknown = {}) {
  return { ok: true, status: 200, json: async () => body };
}

/** Queues the three legs of a fully successful upload, in call order. */
function queueSuccessfulUpload() {
  fetchMock
    // 1. presign
    .mockResolvedValueOnce(
      ok({
        uploadUrl: "https://r2.example/upload",
        publicUrl: "https://cdn.example/ada.png",
      }),
    )
    // 2. PUT the bytes to R2
    .mockResolvedValueOnce(ok())
    // 3. PATCH the profile with the public URL
    .mockResolvedValueOnce(ok());
}

/** The hidden file input behind the "Change avatar" label. */
function fileInput(): HTMLInputElement {
  return screen.getByLabelText(/Change avatar|Uploading/) as HTMLInputElement;
}

/** Selects a valid image, driving `onFileSelected`. */
function selectFile() {
  const file = new File(["bytes"], "ada.png", { type: "image/png" });
  fireEvent.change(fileInput(), { target: { files: [file] } });
}

describe("AvatarUpload", () => {
  it("runs the presign → upload → persist flow, then refreshes", async () => {
    queueSuccessfulUpload();
    render(<AvatarUpload />);

    selectFile();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://r2.example/upload");
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("surfaces the failure inline when persisting the new avatar fails", async () => {
    fetchMock
      .mockResolvedValueOnce(
        ok({
          uploadUrl: "https://r2.example/upload",
          publicUrl: "https://cdn.example/ada.png",
        }),
      )
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({}),
      });
    render(<AvatarUpload />);

    selectFile();

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "Could not save the new avatar.",
      ),
    );
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("does not surface a refresh failure after a successful upload", async () => {
    const consoleErrorMock = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const refreshFailure = new Error("refresh blew up");
    refreshMock.mockImplementationOnce(() => {
      throw refreshFailure;
    });
    queueSuccessfulUpload();
    render(<AvatarUpload />);

    selectFile();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));

    // The avatar IS uploaded and persisted — `status` already committed to
    // "done" — so a throwing `router.refresh()` must not knock it back to
    // "error" and tell the owner their upload failed. The stale avatar on
    // screen is a cosmetic staleness, not a failed upload to retry.
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    // …and the control is left usable rather than stuck on "Uploading…".
    expect(fileInput().disabled).toBe(false);

    expect(consoleErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("router.refresh()"),
      refreshFailure,
    );
  });
});
