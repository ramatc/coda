import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import {
  fetchOnboardingStatus,
  resolveOnboardingRedirect,
} from "../../../lib/onboarding";
import { CreateListForm } from "./create-list-form";

/**
 * Create-list page at `/lists/new` (server component), protected by the Clerk
 * middleware. Runs the onboarding gate — same pattern as every other gated page
 * — then renders the client form island, which owns all form state and calls
 * `POST /lists` with the viewer's token.
 */
export default async function NewListPage() {
  const { getToken } = await auth();
  const token = await getToken();

  const status = await fetchOnboardingStatus(token);
  const redirectTo = resolveOnboardingRedirect(status, "/lists/new");
  if (redirectTo) {
    redirect(redirectTo);
  }

  return <CreateListForm />;
}
