import { auth } from "@clerk/nextjs/server";
import { fetchPopularAlbums } from "../../lib/search";
import { SearchExperience } from "./search-experience";
import { AppShell } from "../_shell/app-shell";

/**
 * Discover/search page at `/search` (server component), protected by the Clerk
 * middleware. Server-renders the initial "popular" albums (Decision #9's
 * server-first data flow) and hands them to the as-you-type client island. The
 * island then drives live, debounced catalog search; results link to each
 * album's detail page (`/albums/[id]`, built in PR9). Wrapped in
 * {@link AppShell}, matching `/home` and `/feed`.
 */
export default async function SearchPage() {
  const { getToken } = await auth();
  const token = await getToken();

  const popular = await fetchPopularAlbums(token);

  // Called (and awaited) as a plain async function rather than used as JSX —
  // see the comment in `app/home/page.tsx` for why.
  return await AppShell({
    children: <SearchExperience initialPopular={popular} />,
  });
}
