# Chrome Web Store Listing

## Product Name

AO3 Find That Bookmark! (Deleted Works)

## Manifest Description

108 characters (Chrome maximum: 132 characters):

> Tracks AO3 bookmarks locally and shows which bookmarked works have been deleted in a private, separate view.

## Detailed Description

AO3 Find That Bookmark! keeps a private, local record of the metadata shown on your own Archive of Our Own bookmarks pages. It periodically checks whether bookmarked works are still available and helps you identify which saved work disappeared.

Deleted works appear in a separate Deleted view added to your AO3 dashboard. The normal AO3 bookmarks list remains untouched.

Features:

- Saves bookmark metadata locally in your browser, including titles, authors, fandoms, tags, summaries, and your bookmark notes.
- Checks bookmarked work availability gradually with randomized delays to limit traffic to AO3.
- Confirms a deletion before alerting you.
- Shows deleted works in a dedicated local view with their saved metadata.
- Provides a user-opened Wayback Machine search link for each deleted work.
- Includes no ads, analytics, tracking, or developer-operated servers.

The extension cannot recover or reproduce deleted works. It stores metadata only. AO3 Find That Bookmark! is an independent project and is not affiliated with the Organization for Transformative Works or Archive of Our Own.

## Category

Productivity

## Language

English

## Single Purpose

Keep a local record of a user's own AO3 bookmarks and identify bookmarked works that have been deleted.

## Permission Justifications

### `alarms`

Schedules small, infrequent bookmark availability checks and resumes interrupted local import work. Check timing includes randomized delays.

### `notifications`

Notifies the user when a bookmarked work is first confirmed deleted or when bookmark import pauses because the AO3 login is unavailable.

### Host access: `*://archiveofourown.org/*`

Required to read the user's own AO3 bookmark pages, capture bookmark metadata, and check whether bookmarked AO3 work URLs remain available. The extension does not access unrelated websites.

## Privacy Practices Guidance

The extension handles the following data solely to provide its user-facing feature:

- AO3 username.
- Website content shown on the user's AO3 bookmark pages.
- User-generated bookmark notes and tags, including private bookmark metadata visible to the logged-in user.
- Saved work metadata and local deletion-check state.

All captured metadata is stored locally in extension IndexedDB. It is not transmitted to the developer, sold, used for advertising, or used for analytics. The extension does not collect general browsing history. Requests are made only to AO3 for the described feature. Wayback Machine is opened only after the user clicks its link.

Use the hosted privacy policy URL in the Developer Dashboard and ensure the dashboard disclosures match it exactly.

## Reviewer Test Instructions

1. Install the extension and sign in to an AO3 account with bookmarks.
2. Open the account's AO3 bookmarks page.
3. Open the extension popup to view import/check status.
4. Confirm a `Deleted (n)` item appears in the AO3 user dashboard.
5. Open `Deleted` to view locally stored records marked deleted.
6. Return to the normal Bookmarks item and confirm the native AO3 bookmark list is unchanged.

Deletion detection depends on the test account containing an unavailable bookmarked work or on the checker confirming one over successive checks.

## Required Graphic Assets

- Store icon: 128 x 128 PNG (already packaged as `icons/icon-128.png`).
- At least one screenshot: 1280 x 800 PNG or JPEG.
- Small promo tile: 440 x 280 PNG or JPEG.
- Optional marquee tile: 1400 x 560 PNG or JPEG.
