import { fetchPopularAlbums } from "../lib/search";
import { fetchPopularReviews } from "../lib/reviews";
import { fetchPopularLists } from "../lib/lists";
import { PublicShell } from "./_landing/public-shell";
import { Hero } from "./_landing/hero";
import { FeatureGrid } from "./_landing/feature-grid";
import { TrendingSection } from "./_landing/trending-section";
import { PopularReviewsSection } from "./_landing/popular-reviews-section";
import { PopularListsSection } from "./_landing/popular-lists-section";
import { BrandStatement } from "./_landing/brand-statement";
import { FinalCta } from "./_landing/final-cta";

/**
 * Public landing page (`/`), rendered identically for anonymous and signed-in
 * visitors: it makes no Clerk call and never redirects to `/home`.
 *
 * The three popular-content reads run in parallel against the `@Public()`
 * endpoints with no viewer token (`null`). Each helper fails safe to `[]`, so
 * an unreachable API degrades every data-wired section to its empty state
 * instead of failing the render.
 *
 * {@link PublicShell} owns the `<main>` landmark and {@link Hero} owns the
 * page's only `<h1>`, so this page adds neither.
 */
export default async function LandingPage() {
  const [albums, reviews, lists] = await Promise.all([
    fetchPopularAlbums(null),
    fetchPopularReviews(null),
    fetchPopularLists(null),
  ]);

  return (
    <PublicShell>
      <Hero />
      <FeatureGrid />
      <TrendingSection albums={albums} />
      <PopularReviewsSection reviews={reviews} />
      <PopularListsSection lists={lists} />
      <BrandStatement />
      <FinalCta />
    </PublicShell>
  );
}
