# AO3 Find That Bookmark! — Manual Test Checklist

The extension has no manual import/settings/backup controls; importing and
checking happen automatically in the background. These checks should be run on a
real, logged-in AO3 account, since the import and on-page injection depend on
AO3's live HTML.

## Loading

- Build with `npm run build`.
- Load the unpacked Chrome extension from `dist/ao3-lost-and-found-chrome`.
- Load the temporary Firefox add-on from `dist/ao3-lost-and-found-firefox` (select its `manifest.json`).
- Confirm the popup opens without console errors.
- Confirm AO3 user pages load `bookmarks-injector.js` without console errors.

## Automatic import

- Visiting your own AO3 bookmarks page while logged in starts a background import with no prompt.
- Visiting another user's bookmarks (not your own) does NOT start an import.
- The popup shows "N bookmarks accounted for" once records exist.
- Revisiting your bookmarks after the first import does not re-walk every page; newly added bookmarks are picked up by a small sweep of the newest pages on each scheduled run.
- Un-bookmarking a work does not remove its record; it stays tracked and checked.

## Checking and status

- Background checks run on the schedule without user action.
- A work that returns deleted is only confirmed after repeated checks (no single-failure false alarms).
- A restricted/locked work (401/403) is never mistaken for a deletion.
- Confirmed deleted works update the popup count.
- A Cloudflare "verify you're human" response never changes a work's status; the run stops and resumes later.
- After an AO3 outage clears, no work becomes deleted without fresh checks.

## Badge and notification

- The toolbar icon shows a red badge with the count of deleted works.
- Hovering the icon shows a tooltip describing how many works may be gone.
- The badge clears when the count reaches zero.
- A browser notification fires once on first confirmation of a deleted work and does not repeat for the same work.
- Clicking the notification opens your AO3 bookmarks page.

## Popup "fic has left the building" alert

- When newly lost works are detected, the hint changes to "X/Y bookmarks accounted for…uh oh, a fic has left the building" (plural: "fics have").
- Clicking the alert message (or focusing it and pressing Enter/Space) opens the Deleted view in a new tab; viewing it acknowledges the alert, which reverts to "N bookmarks accounted for".
- Acknowledged losses do not re-trigger the alert; only genuinely new losses do.
- The alert wraps cleanly within the popup when long and does not overflow.

## Re-check and "Find it now" (popup)

- "Re-check deleted works" keeps every deleted work in the list; works that load again drop off over the next runs, and no badge or notification fires again for deletions already seen.
- "Find it now" on a page with a deleted placeholder: a match by bookmark id is marked deleted at once; a match by position is marked deleted only after AO3 confirms the work is gone, otherwise it is listed under "Possible matches".

## Deleted view (bookmarks page)

- Normal AO3 bookmark pages are visually unchanged.
- The user sidebar shows a "Deleted (N)" entry beneath "Gifts" on your own pages only; another user's profile or bookmarks shows no Deleted entry.
- Clicking it shows just the deleted works, with a heading like "N found deleted works in <user>'s bookmarks".
- With more than 20 deleted works, a pager appears below the list and every page is reachable.
- Pressing Back from the Deleted view returns to the normal bookmarks list, fully loaded (not empty).
- The Wayback Machine link on each deleted work opens the correct archive search URL in a new tab.
- Titles and tags with apostrophes or dashes display correctly (no `&#39;`).

## Privacy

- No AO3 username is displayed anywhere in the popup.
- Clearing AO3 site data in the browser does not affect stored records (data lives in the extension origin).
