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
- Revisiting your bookmarks after data already exists does not re-walk every page unless the prior import is stale.

## Checking and status

- Background checks run on the schedule without user action.
- A work that returns deleted is only confirmed after repeated checks (no single-failure false alarms).
- A restricted/locked work (401/403) is never mistaken for a deletion.
- Confirmed deleted works update the popup count.

## Badge and notification

- The toolbar icon shows a red badge with the count of deleted works.
- Hovering the icon shows a tooltip describing how many works may be gone.
- The badge clears when the count reaches zero.
- A browser notification fires once on first confirmation of a deleted work and does not repeat for the same work.
- Clicking the notification opens your AO3 bookmarks page.

## Popup "fic has left the building" alert

- When newly lost works are detected, the hint changes to "X/Y bookmarks accounted for…uh oh, a fic has left the building" (plural: "fics have").
- Clicking the alert message (or focusing it and pressing Enter/Space) acknowledges it and reverts to "N bookmarks accounted for".
- Acknowledged losses do not re-trigger the alert; only genuinely new losses do.
- The alert wraps cleanly within the popup when long and does not overflow.

## On-page injection (bookmarks page)

- Deleted works appear pinned at the top of the bookmarks page with deleted styling.
- The Wayback Machine link appears on deleted blurbs and opens the correct archive search URL in a new tab.
- "Return to original position" moves a work and persists after reload.
- The user sidebar shows a "Deleted" entry with a count, placed beneath "Gifts".
- Clicking a sidebar entry filters the bookmarks page to just those works, with a heading like "N found deleted works in <user>'s bookmarks".

## Privacy

- No AO3 username is displayed anywhere in the popup.
- Clearing AO3 site data in the browser does not affect stored records (data lives in the extension origin).
