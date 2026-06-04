# AO3 Find That Bookmark!

Find That Bookmark keeps a small, local record of the works you've bookmarked on AO3. It saves just the details AO3 already shows on your bookmarks page, such as title, author, tags, and summary.

Every so often it checks whether those works are still up. If one has been deleted, it flags it, so you can finally answer "wait, which one was that?".

## What it does

- Reads your own AO3 bookmarks while you're logged in, and keeps a local copy of the details AO3 already shows there.
- Checks, a little at a time, whether each bookmarked work is still up.
- Flags works that have been deleted, and shows their saved details back on your bookmarks page so you can see which ones went missing.
- Adds a Deleted entry to your bookmarks sidebar so you can filter to just those works.
- Links out to the Wayback Machine in case you want to look for an archived copy.

## What it does not do

- It does not store, copy, host, or repost the works themselves. It only keeps the bookmark details you already saved.
- It cannot bring deleted works back. AO3 removes the work, and the extension just tells you which of your bookmarks is affected.
- It does not upload or share anything. Everything stays in your browser, on your device, and is only ever sent to AO3 itself, where you are already logged in.

## Throttled on purpose

Checking for deleted bookmarks happens every so often and at random intervals within a range of time, which is a low intensity way to interact with AO3's servers. The trade off is that a freshly deleted work will not be reported the instant it disappears. It also waits to confirm a work is really gone, rather than missing for a moment, before flagging it. In practice, a deletion is usually identified within a day or two rather than instantly. If you have a very large number of bookmarks, it can take a bit longer.

## Privacy

All of your information is yours. Nothing is uploaded, shared, or sent anywhere. There are no servers, and the extension cannot recover deleted works (only AO3 has those). It just tells you which of yours have gone missing.

The local database lives in the extension itself, not on the AO3 website, so clearing AO3 site data in your browser will not affect your saved records.

## Install for development

```sh
npm install
npm test
npm run build
```

`npm run build` creates loadable, unpacked extension folders in `dist/`:

- `dist/ao3-lost-and-found-chrome` for Chrome and other Chromium browsers. Open chrome://extensions, turn on Developer mode, and use "Load unpacked".
- `dist/ao3-lost-and-found-firefox` for Firefox. Open about:debugging, choose "Load Temporary Add-on", and pick its `manifest.json`.

The project keeps a separate manifest for each browser (`manifest.chrome.json` and `manifest.firefox.json`), and the build copies the right one in as `manifest.json`.

## Fonts

The popup uses the Lexend font, which ships with its license in `fonts/Lexend-OFL.txt`.
