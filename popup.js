const runtime = globalThis.browser || globalThis.chrome;
const C = globalThis.AO3LostAndFoundConstants;

const elements = {
  deletedCount: document.querySelector("#deletedCount"),
  deletedNum: document.querySelector("#deletedNum"),
  hint: document.querySelector("#hint"),
  recheckButton: document.querySelector("#recheckButton"),
  recheckResult: document.querySelector("#recheckResult"),
  notice: document.querySelector("#outageNotice"),
  noticeBody: document.querySelector("#outageBody"),
  noticeOpen: document.querySelector("#outageOpen"),
  noticeDismiss: document.querySelector("#outageDismiss"),
  outageInfo: document.querySelector("#outageInfo")
};

// The filtered deleted-works URL for the current user; opening it is what
// acknowledges the "new" alert (the injector clears it once the list renders).
let currentFilterUrl = "";

function bookmarksFilterUrl(username, status) {
  return `https://archiveofourown.org/users/${encodeURIComponent(username)}/bookmarks?ao3_lost_found=${status}`;
}

function render(stats = {}) {
  const username = stats.username || "";
  const deleted = Number(stats.deleted) || 0;
  const total = Number(stats.total) || 0;

  elements.deletedNum.textContent = String(deleted);
  const outage = stats.outageNotice;
  // Still waiting for AO3 to come back and the cleanup to run.
  const outagePending = Boolean(outage && !outage.resolved);
  renderOutageNotice(outage);
  elements.outageInfo.hidden = !stats.outageAffected;
  // The outage cleanup is automatic; don't offer a competing manual re-check.
  elements.recheckButton.hidden = deleted === 0 || outagePending;

  currentFilterUrl = username ? bookmarksFilterUrl(username, C.STATUS.DELETED) : "";
  if (username) {
    elements.deletedCount.href = currentFilterUrl;
  } else {
    elements.deletedCount.removeAttribute("href");
  }

  const newLost = Number(stats.newLost) || 0;

  if (total === 0) {
    elements.hint.textContent = "Visit your AO3 bookmarks page to get started.";
    setAlert(false);
  } else if (outagePending) {
    // Don't sound the "fics have left the building" alarm over outage noise.
    elements.hint.textContent = `${total.toLocaleString()} bookmarks tracked`;
    setAlert(false);
  } else if (newLost > 0) {
    const accounted = Math.max(0, total - newLost);
    const subject = newLost === 1 ? "a fic has" : "fics have";
    elements.hint.textContent =
      `${accounted.toLocaleString()}/${total.toLocaleString()} bookmarks accounted for…uh oh, ${subject} left the building`;
    setAlert(true);
  } else {
    elements.hint.textContent = `${total.toLocaleString()} bookmarks accounted for`;
    setAlert(false);
  }
}

function setAlert(on) {
  elements.hint.classList.toggle("hint--alert", on);
  elements.hint.setAttribute("role", on ? "link" : "status");
  if (on) {
    elements.hint.setAttribute("tabindex", "0");
    elements.hint.title = "Click to see which one";
  } else {
    elements.hint.removeAttribute("tabindex");
    elements.hint.removeAttribute("title");
  }
}

// Acknowledgement happens by *viewing* the deleted works, not by dismissing a
// banner: open the filtered list, and the injector clears the alert + badge once
// it renders. The Deleted tile does the same; this just makes the alarming line
// itself actionable.
function openDeletedWorks() {
  if (!elements.hint.classList.contains("hint--alert") || !currentFilterUrl) return;
  if (runtime?.tabs?.create) {
    runtime.tabs.create({ url: currentFilterUrl });
  } else {
    window.open(currentFilterUrl, "_blank", "noreferrer");
  }
}

elements.hint.addEventListener("click", openDeletedWorks);
elements.hint.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    openDeletedWorks();
  }
});

function plural(n, word) {
  return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
}

// Informational only: the cleanup runs by itself once AO3 is back. The notice
// reassures, and clicking it opens the full write-up in the help panel.
function renderOutageNotice(outage) {
  elements.notice.hidden = !outage;
  if (!outage) return;

  elements.notice.classList.toggle("notice--resolved", Boolean(outage.resolved));
  if (!outage.resolved) {
    elements.noticeBody.textContent =
      "Deletion alerts from the outage are false alarms, so feel free to dismiss them. Your list cleans itself up once AO3 is back, and deletions from before Oct 29 stay put.";
  } else {
    const cleared = Number(outage.cleared) || 0;
    elements.noticeBody.textContent = cleared > 0
      ? `All cleaned up: ${plural(cleared, "false alarm")} cleared. Your deletions from before Oct 29 were kept.`
      : "All cleaned up. Your deletions from before Oct 29 were kept.";
  }
}

function dismissOutageNotice() {
  elements.notice.hidden = true;
  runtime?.runtime?.sendMessage?.({ type: C.MSG.DISMISS_OUTAGE_NOTICE })?.catch?.(() => {});
}

// Reading the write-up counts as seeing the notice; it stays in the help panel.
elements.noticeOpen.addEventListener("click", () => {
  setInfoOpen(true);
  elements.outageInfo.scrollIntoView({ block: "start" });
  dismissOutageNotice();
});
elements.noticeDismiss.addEventListener("click", dismissOutageNotice);

// Sends every deleted work back through confirmation, for when AO3 had an
// outage and flagged works that are actually fine.
elements.recheckButton.addEventListener("click", async () => {
  elements.recheckButton.disabled = true;
  try {
    const res = await runtime.runtime.sendMessage({ type: C.MSG.RECHECK_LOST });
    if (res?.success) {
      const n = res.reverifying;
      elements.recheckResult.textContent = n
        ? `Re-checking ${n.toLocaleString()} work${n === 1 ? "" : "s"}. Ones that are still up will come off the list over the next day or so.`
        : "Nothing to re-check.";
      refresh().catch(() => {});
    } else {
      elements.recheckResult.textContent = res?.error || "Couldn't start a re-check. Try again.";
    }
  } catch (error) {
    elements.recheckResult.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    elements.recheckButton.disabled = false;
  }
});

async function refresh() {
  if (!runtime?.runtime?.sendMessage) {
    elements.hint.textContent = "Extension runtime is unavailable.";
    return;
  }
  try {
    render(await runtime.runtime.sendMessage({ type: C.MSG.GET_STATS }));
  } catch (error) {
    elements.hint.textContent = error instanceof Error ? error.message : String(error);
  }
}

// "How it works" info panel toggle.
const popupEl = document.querySelector(".popup");
const infoButton = document.querySelector("#infoButton");
const infoClose = document.querySelector("#infoClose");

function setInfoOpen(open) {
  popupEl.classList.toggle("popup--info-open", open);
  infoButton.setAttribute("aria-expanded", open ? "true" : "false");
}

infoButton?.addEventListener("click", () => {
  setInfoOpen(!popupEl.classList.contains("popup--info-open"));
});
infoClose?.addEventListener("click", () => setInfoOpen(false));

// Help-panel footer: review, bug report (mailto), and feature request.
const CONTACT_EMAIL = "marciepublishes@gmail.com"; // support address for bug reports and feature ideas
const GITHUB_ISSUES_URL = "https://github.com/marciepublishes/AO3-Find-That-Bookmark-/issues"; // public issue tracker
const STORE_REVIEW_URL = ""; // set after publishing (e.g. the Chrome Web Store reviews page)

const reviewLink = document.querySelector("#reviewLink");
const bugLink = document.querySelector("#bugLink");
const bugNote = document.querySelector("#bugNote");
const bugMail = document.querySelector("#bugMail");
const bugGitHub = document.querySelector("#bugGitHub");
const featureLink = document.querySelector("#featureLink");
const featureNote = document.querySelector("#featureNote");
const featureMail = document.querySelector("#featureMail");
const featureGitHub = document.querySelector("#featureGitHub");

function mailto(subject) {
  return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}`;
}

if (bugMail) bugMail.href = mailto("Bug report - AO3 Find That Bookmark!");
if (featureMail) featureMail.href = mailto("Feature idea - AO3 Find That Bookmark!");
if (bugGitHub) bugGitHub.href = GITHUB_ISSUES_URL;
if (featureGitHub) featureGitHub.href = GITHUB_ISSUES_URL;

if (reviewLink) {
  if (STORE_REVIEW_URL) {
    reviewLink.href = STORE_REVIEW_URL;
  } else {
    reviewLink.classList.add("info-footer__link--disabled");
    reviewLink.title = "Available once the extension is published";
  }
}

// Bug report and feature request each expand a note; only one is open at a time.
function toggleNote(link, note, otherLink, otherNote) {
  const opening = note.hasAttribute("hidden");
  note.toggleAttribute("hidden", !opening);
  link.setAttribute("aria-expanded", opening ? "true" : "false");
  if (opening && otherNote && !otherNote.hasAttribute("hidden")) {
    otherNote.setAttribute("hidden", "");
    otherLink?.setAttribute("aria-expanded", "false");
  }
  if (opening) {
    note.scrollIntoView({ behavior: "smooth", block: "end" });
  }
}

bugLink?.addEventListener("click", () => toggleNote(bugLink, bugNote, featureLink, featureNote));
featureLink?.addEventListener("click", () => toggleNote(featureLink, featureNote, bugLink, bugNote));

// ── Find-it-now: check a single bookmarks page on demand ───────────────────
const finder = {
  toggle: document.querySelector("#finderToggle"),
  body: document.querySelector("#finderBody"),
  form: document.querySelector("#finderForm"),
  page: document.querySelector("#finderPage"),
  submit: document.querySelector("#finderSubmit"),
  result: document.querySelector("#finderResult")
};

function workLink(work) {
  const url = `https://archiveofourown.org/works/${encodeURIComponent(work.workId)}`;
  const title = work.title || `Work ${work.workId}`;
  const by = (work.authors && work.authors.length) ? ` by ${work.authors.join(", ")}` : "";
  const when = work.dateBookmarked ? ` (bookmarked ${work.dateBookmarked})` : "";
  return `<a href="${url}" target="_blank" rel="noreferrer">${escapeHtml(title)}</a>${escapeHtml(by + when)}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderFinderResult(res) {
  if (!res || res.success === false) {
    finder.result.textContent = (res && res.error) || "Couldn't check that page. Try again.";
    return;
  }

  const parts = [];
  if (res.confirmed && res.confirmed.length) {
    parts.push(`<p class="finder__found">Found ${res.confirmed.length === 1 ? "it" : `${res.confirmed.length} gone`} — marked deleted:</p>`);
    parts.push(`<ul class="finder__list">${res.confirmed.map((w) => `<li>${workLink(w)}</li>`).join("")}</ul>`);
  }
  if (res.ambiguous && res.ambiguous.length) {
    parts.push(`<p class="finder__ambiguous">A bookmark on this page is gone, but I couldn't confirm which one. Possible matches:</p>`);
    res.ambiguous.forEach((group) => {
      parts.push(`<ul class="finder__list">${group.candidates.map((w) => `<li>${workLink(w)}</li>`).join("")}</ul>`);
    });
  }
  if (parts.length === 0) {
    parts.push(`<p class="finder__clear">No missing works on page ${res.page} — everything there is still up.</p>`);
  }

  finder.result.innerHTML = parts.join("");
}

finder.toggle?.addEventListener("click", () => {
  const opening = finder.body.hasAttribute("hidden");
  finder.body.toggleAttribute("hidden", !opening);
  finder.toggle.setAttribute("aria-expanded", opening ? "true" : "false");
});

finder.form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const page = Number(finder.page.value);
  if (!Number.isFinite(page) || page < 1) {
    finder.result.textContent = "Enter a page number (1 or higher).";
    return;
  }

  finder.submit.disabled = true;
  finder.result.textContent = `Checking page ${page}…`;
  try {
    const res = await runtime.runtime.sendMessage({ type: C.MSG.FIND_MISSING_ON_PAGE, page });
    renderFinderResult(res);
    if (res?.confirmed?.length) refresh().catch(() => {});
  } catch (error) {
    finder.result.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    finder.submit.disabled = false;
  }
});

// Live updates pushed from the background while the popup is open.
runtime?.runtime?.onMessage?.addListener((message) => {
  if (message?.type === C.MSG.STATS_UPDATED) {
    render(message.stats || {});
  } else if (message?.type === C.MSG.CHECK_CONFIRMED || message?.type === C.MSG.IMPORT_COMPLETE) {
    refresh().catch(() => {});
  }
});

refresh();
