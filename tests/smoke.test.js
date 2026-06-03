const fs = require("fs");
const path = require("path");

describe("Phase 1 scaffold", () => {
  test("Chrome and Firefox manifests both reference the AO3 bookmarks injector", () => {
    const root = path.resolve(__dirname, "..");
    const chromeManifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.chrome.json"), "utf8"));
    const firefoxManifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.firefox.json"), "utf8"));

    expect(chromeManifest.content_scripts[0].js).toContain("bookmarks-injector.js");
    expect(firefoxManifest.content_scripts[0].js).toContain("bookmarks-injector.js");
  });

  test("content script runs on all AO3 user dashboard pages", () => {
    const root = path.resolve(__dirname, "..");
    const chromeManifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.chrome.json"), "utf8"));
    const firefoxManifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.firefox.json"), "utf8"));

    expect(chromeManifest.content_scripts[0].matches).toContain("*://archiveofourown.org/users/*");
    expect(firefoxManifest.content_scripts[0].matches).toContain("*://archiveofourown.org/users/*");
  });
});
