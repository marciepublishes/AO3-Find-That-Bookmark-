const runtime = globalThis.browser || globalThis.chrome;
const C = globalThis.AO3LostAndFoundConstants;

const elements = {
  deletedCount: document.querySelector("#deletedCount"),
  orphanedCount: document.querySelector("#orphanedCount"),
  deletedNum: document.querySelector("#deletedNum"),
  orphanedNum: document.querySelector("#orphanedNum"),
  hint: document.querySelector("#hint")
};

function bookmarksFilterUrl(username, status) {
  return `https://archiveofourown.org/users/${encodeURIComponent(username)}/bookmarks?ao3_lost_found=${status}`;
}

function render(stats = {}) {
  const username = stats.username || "";
  const deleted = Number(stats.deleted) || 0;
  const orphaned = Number(stats.orphaned) || 0;
  const total = Number(stats.total) || 0;

  elements.deletedNum.textContent = String(deleted);
  elements.orphanedNum.textContent = String(orphaned);

  if (username) {
    elements.deletedCount.href = bookmarksFilterUrl(username, C.STATUS.DELETED);
    elements.orphanedCount.href = bookmarksFilterUrl(username, C.STATUS.ORPHANED);
  } else {
    elements.deletedCount.removeAttribute("href");
    elements.orphanedCount.removeAttribute("href");
  }

  const newLost = Number(stats.newLost) || 0;

  if (total === 0) {
    elements.hint.textContent = "Visit your AO3 bookmarks page to get started.";
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
  elements.hint.setAttribute("role", on ? "button" : "status");
  if (on) {
    elements.hint.setAttribute("tabindex", "0");
    elements.hint.title = "Click to dismiss";
  } else {
    elements.hint.removeAttribute("tabindex");
    elements.hint.removeAttribute("title");
  }
}

async function acknowledge() {
  if (!elements.hint.classList.contains("hint--alert")) return;
  try {
    const response = await runtime.runtime.sendMessage({ type: C.MSG.ACKNOWLEDGE_LOST });
    if (response?.stats) render(response.stats);
  } catch (error) {
    // Leave the alert in place if acknowledgement failed.
  }
}

elements.hint.addEventListener("click", acknowledge);
elements.hint.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    acknowledge();
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
const STORE_REVIEW_URL = ""; // set after publishing (e.g. the Chrome Web Store reviews page)

const reviewLink = document.querySelector("#reviewLink");
const bugLink = document.querySelector("#bugLink");
const featureLink = document.querySelector("#featureLink");
const featureNote = document.querySelector("#featureNote");
const featureMail = document.querySelector("#featureMail");

function mailto(subject) {
  return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}`;
}

if (bugLink) bugLink.href = mailto("Bug report - AO3 Find That Bookmark!");
if (featureMail) featureMail.href = mailto("Feature idea - AO3 Find That Bookmark!");

if (reviewLink) {
  if (STORE_REVIEW_URL) {
    reviewLink.href = STORE_REVIEW_URL;
  } else {
    reviewLink.classList.add("info-footer__link--disabled");
    reviewLink.title = "Available once the extension is published";
  }
}

featureLink?.addEventListener("click", () => {
  const opening = featureNote.hasAttribute("hidden");
  featureNote.toggleAttribute("hidden", !opening);
  featureLink.setAttribute("aria-expanded", opening ? "true" : "false");
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
