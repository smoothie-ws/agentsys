# CHECKPOINT-07 — UI and UX

Written 2026-11-14T15:43+10:00.

## 1. What was investigated

Dashboard, Projects, Library, Collections, Environments, Plugins, Settings and API pages at 1440×900, 1024×768
and 390×844; empty states; a page whose server is unreachable; keyboard search; the phone navigation sheet;
error messages. Screenshots saved in `screenshots/`.

## 2. Hypotheses checked

- Empty states name what is missing: **confirmed** (Projects, Plugins, Collections).
- Every main page fits without horizontal overflow at desktop and tablet widths: **confirmed**.
- A page whose server is away keeps its context and offers a way forward: **disproved** — the router replaced
  the whole view with "Could not open this page" and a single Back link, losing the page title.
- Environments and Collections are reachable from search: **disproved** — neither was in the destination list.
- Escape closes the search dialog: **partially** — the first Escape only cleared the `type="search"` field
  (Chromium's native behaviour); the second closed it.
- The phone layout has its own navigation and no overflow: **confirmed**; the sheet opens from the bottom bar
  and closes with Escape, returning focus.

## 3. Defects reproduced

Three UX defects above.

## 4. Fixes

Router error state keeps the requested page title, explains a connection failure in words, offers **Try again**
and the parent page; Environments and Collections added to search; the search field closes the dialog on Escape
explicitly.

## 5. Tests

`tests/browser_ux.py` 8/8, screenshots regenerated (JPEG, ~130 KB total).

## 6. Results

No redesign. Each change is small, testable, and keeps the reader's place. The phone layout needed no change.

## 7. Next

API compatibility and the published contract.
