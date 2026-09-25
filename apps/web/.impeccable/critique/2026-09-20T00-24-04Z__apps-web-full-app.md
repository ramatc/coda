---
target: apps/web (full app)
total_score: 15
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 2
timestamp: 2026-09-20T00-24-04Z
slug: apps-web-full-app
---
## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | No loading/saving indicator beyond disabled controls; `router.refresh()` gives no spinner |
| 2 | Match System / Real World | 3 | "Diary", "Want to listen" read clearly; solid |
| 3 | User Control and Freedom | 1 | Clearing a rating is one click, no confirm, cascades the attached review away |
| 4 | Consistency and Standards | 1 | Two full visual/component languages coexist; rating rendered 3 different ways (segmented bar / native `<select>` / plain text) |
| 5 | Error Prevention | 1 | No confirm before destructive rating/review delete; onboarding "Next" just disables, doesn't explain why |
| 6 | Recognition Rather Than Recall | 2 | Legacy pages give no way back into the app but browser Back |
| 7 | Flexibility and Efficiency | 1 | No shortcuts, no bulk actions, no keyboard rating input |
| 8 | Aesthetic and Minimalist Design | 2 | /home and /feed are clean; legacy screens are dense and visually inconsistent |
| 9 | Error Recovery | 1 | Generic "Something went wrong." with no retry affordance |
| 10 | Help and Documentation | 1 | Zero onboarding hints or empty-state guidance beyond static sentences |
| **Total** | | **15/40** | **Poor — major UX overhaul required** |

## Design Specificity Verdict

**LLM assessment (Assessment A)**: Low-to-moderate. The OKLCH token system and the segmented `RatingScale` component show real design thinking, but `RatingScale` is built, tested, and exported from `packages/ui` — and used **nowhere** in `apps/web`. Every real rating interaction in the shipped product is either a bare native `<select>` (album detail) or plain text (feed/friends-preview). Strip the "CODA" wordmark and the violet accent, and most screens — a dark dashboard with cards, a searchable grid, a profile with follower counts — could belong to almost any media-tracking app. The redesign touched two routes' chrome, not the product's core interaction (rating).

**Deterministic scan (Assessment B)**: The CLI detector flagged 9 `broken-image` warnings across `activity-feed.tsx`, `album-detail.tsx`, `feed-list.tsx` (×2), `friends-preview.tsx`, `popular-row.tsx`, `recommendations.tsx`, `search-results.tsx`, `profile-view.tsx`. All 9 were manually verified as **false positives** — every one is a conditionally-rendered `<img src={coverUrl/avatarUrl}>` bound to a real, non-empty API value, with an explicit source comment documenting the `next/image` migration as a known, deliberate, repo-wide deferral. This is a coherent, intentional pattern, not sloppy implementation — worth noting since it's the single largest mechanical finding and it nets to zero.

The browser-injected live scan told a different, more useful story: even the two "finished" screens have unresolved mechanical gaps. `/home` and `/feed` both render their BottomNav labels ("Home", "Search", "Diary", "Lists", "You") at **10px — below the tool's 11px minimum-readability floor** — the same component, so one fix clears it everywhere. `/home` also shows a flat type hierarchy (10–18px range, 1.8:1 ratio) and a `dark-glow` box-shadow on the header's "+LOG" control. `/u/ramatc` (legacy) independently shows the same flat-hierarchy pattern (1.7:1 ratio) — corroborating Assessment A's read that legacy screens lack type-scale discipline, but now with hard numbers. Net: the "good" screens are cleaner but not finished either; the redesign is shallower than its own flagship pages suggest.

## Overall Impression

Coda has one real design foundation (the OKLCH token system) and one real showcase component (`RatingScale`) — and neither has reached the screen where they'd matter most. Two routes got a genuine facelift; the other seven are stuck on old styling under a dark background the redesign never intended for them, which reads as broken rather than "in progress." The single biggest opportunity: finish what's already built (ship `RatingScale` to the one screen where users rate, extend the shell to the rest of the app) before adding anything new.

## What's Working

- **OKLCH token discipline** (`packages/config/tailwind/preset.css`): a well-structured semantic scale (`background` → `surface-1/2/raised` → `border-subtle/strong`) with a single-purpose accent (`coda`) explicitly documented as "your relationship with the music," not a generic brand color. The right foundation, unfinished.
- **`RatingScale` component** (`packages/ui/src/components/rating-scale.tsx`): a thoughtful API (personal/other/aggregate variants, fractional-fill math with a float-rounding guard) — genuinely above-average component engineering that currently ships to nobody.
- **BottomNav route taxonomy** (`_shell/bottom-nav.tsx`): Home/Search/Diary/Lists/You maps cleanly onto real, distinct routes — coherent IA where the shell is actually present.

## Priority Issues

**[P0] Two visual languages coexist across the app, and the redesign only reaches 2 of ~9 routes**
- **Why it matters**: `/search`, `/albums/[id]`, `/u/[username]` inherit the new dark `bg-background` from the root layout but keep light-UI-era component styling (`bg-white` buttons, `border-brand-200` hairlines, opacity values tuned for a white background) and a different violet shade (`brand-600`) than the new `coda` token. This is an unintended hybrid, worse than either pure state — it reads as broken, not unfinished.
- **Fix**: Either finish migrating the remaining routes to the semantic tokens (same pattern already used on /home, /feed), or gate the dark background behind the shell so unmigrated routes keep their original light background until their turn.
- **Suggested command**: `/impeccable polish` (repo-wide token pass) or `/impeccable layout` per route.

**[P0] No persistent navigation on `/search`, `/albums/[id]`, `/u/[username]`**
- **Why it matters**: None of these three pages import `Header`/`BottomNav`. A user who taps into search, opens an album, or opens a profile is stranded with no way back except the browser Back button — a functional dead-end, not just a style gap.
- **Fix**: Wrap these routes in the existing `AppShell` — it's already a drop-in `{children}` wrapper, so this is close to a one-line change per page.
- **Suggested command**: `/impeccable layout`

**[P1] The flagship rating component is unshipped — the core interaction uses a bare native `<select>`**
- **Why it matters**: `album-actions.tsx` renders `<select aria-label="Your rating">` with numeric options and no custom styling, while `RatingScale` sits unused. For a Letterboxd-for-music app, rating IS the product — its input surface currently looks like an unstyled HTML form.
- **Fix**: Build the interactive/drag-to-rate variant of `RatingScale` the component's own docs flag as deferred, wire it into album detail, and use `RatingScale` (not plain text) in `FeedList`/`FriendsPreview` too.
- **Suggested command**: `/impeccable typeset` → `/impeccable delight` (interaction), then `/impeccable polish`

**[P1] Clearing a rating is one click, no confirmation, and silently deletes the attached review**
- **Why it matters**: Selecting "—" in the rating dropdown cascade-deletes any attached review with zero warning, zero undo — the highest-stakes moment in the flow gets the least ceremony (less than adding an album to a list).
- **Fix**: Add a confirm step when a review is attached: "Clearing your rating will also delete your review — continue?"
- **Suggested command**: `/impeccable harden`

**[P2] BottomNav labels render at 10px — below accessibility-readable size — on both finished screens**
- **Why it matters**: Detector-verified (not a judgment call): "Home", "Search", "Diary", "Lists", "You" all render under the 11px floor on `/home` and `/feed`. One shared component, one fix, clears it app-wide the moment the shell reaches other routes too.
- **Fix**: Bump the BottomNav label font-size token by 1-2px; re-run `/impeccable audit` to confirm the floor is cleared.
- **Suggested command**: `/impeccable typeset`

**[P2] Home's first-run empty states have no CTA**
- **Why it matters**: "Follow people to see what they listen to..." and "Rate a few albums..." are static italic text, not links — a new user hits two dead ends stacked right under a populated Popular row.
- **Fix**: Turn these into real buttons linking to `/search` — the copy already implies the action, it just isn't clickable.
- **Suggested command**: `/impeccable clarify` → `/impeccable delight`

## Persona Red Flags

**Jordan (first-timer), logging their first album**: After onboarding, Jordan lands on `/home`, taps an album cover, and arrives at `/albums/[id]` — a visually disconnected legacy screen with no header, logo, or nav (just floats at the top of a black page). To rate, Jordan meets a raw `<select>`, not the app's showcase widget. To get back to Home there's no button, only browser Back. Jordan's very first core action happens on the app's worst-designed, most disconnected screen.

**Sam (accessibility), any screen**: `RatingScale`'s segments are properly `aria-hidden` with the value announced via `aria-label` — but the far uglier native `<select>` on album detail is, ironically, the *most* accessible rating control in the app. Independently, the detector confirmed BottomNav labels sit below the 11px readability floor on both finished screens, and several legacy-screen opacity values (`opacity-50`/`60`/`70`, calibrated for a light background) look visually close to invisible against the now-inherited dark background in screenshots — worth a contrast check before further polish.

**Riley (stress-tester), rapidly rate/unrate**: The codebase's own comments show real race-condition fixes already fought over (`pendingRefresh` vs. overlapping mutations) — a good sign it was stress-tested. But the UI gives zero feedback during the lock window: the textarea just silently disables with no toast or spinner explaining why, which reads as a bug rather than a safety guard.

## Minor Observations

- `/search`'s heading uses `brand-600`; `/home`'s "+LOG" button uses `coda` — visibly different violets side-by-side.
- Album cover fallback on `/albums/[id]` uses a light-theme color pair (`bg-brand-100`/`text-brand-700`) — renders as a near-invisible pale box on the dark inherited background for any album missing cover art.
- Empty-state copy voice is inconsistent across three instances ("Your feed is empty. Follow people..." / "Follow people to see..." / "No recommendations yet...") — worth unifying into one empty-state component/pattern.
- Onboarding step pills render lowercase raw enum values ("genres", "artists", "albums") as labels — reads like uncopyedited placeholder text.
- Detector: a `dark-glow` box-shadow effect on the header's "+LOG" control (`/home`) — a known AI-slop tell worth a deliberate look, not necessarily a keep.
- Detector: `/feed`'s empty-state copy runs ~91 characters/line (aim <80).
- Detector: `/search` uses only one typeface in-view — neutral, not a real issue given the page is pre-migration.

## Questions to Consider

- If `RatingScale` was built and tested but never wired into the one screen where users actually rate something, was "ship the redesign to /home and /feed" the right slice — or did the team redesign the two screens that *display* ratings while leaving the one that *creates* them untouched?
- Is the dark background on legacy pages an accident of the root layout change, or a known interim state? Right now it reads as broken, not "in progress" — worth deciding explicitly.
- Given rating-then-reviewing is the core loop, why does clearing a rating get less confirmation ceremony than adding an album to a list?
