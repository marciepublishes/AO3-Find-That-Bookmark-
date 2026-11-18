#!/usr/bin/env node
/**
 * Assembles loadable, unpacked extension folders under dist/ and zips each one
 * for store upload.
 *
 * Browsers require the manifest to be named exactly `manifest.json`, so this
 * copies the shared source files plus the browser-specific manifest (renamed)
 * into a per-target directory, then produces a matching .zip. Run with
 * `npm run build`.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const distRoot = path.join(root, "dist");

// Files and directories shared by every target. The Lexend font ships with its
// OFL license, as the license requires.
const SHARED = [
  "background.js",
  "bookmarks-injector.js",
  "popup.html",
  "popup.js",
  "popup.css",
  "fonts/Lexend-Regular.ttf",
  "fonts/Lexend-Bold.ttf",
  "fonts/Lexend-OFL.txt",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png",
  "lib",
  "modules"
];

const TARGETS = [
  { name: "ao3-lost-and-found-chrome", manifest: "manifest.chrome.json" },
  { name: "ao3-lost-and-found-firefox", manifest: "manifest.firefox.json" }
];

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function zipDir(srcDir, zipPath) {
  fs.rmSync(zipPath, { force: true });
  if (process.platform === "win32") {
    execFileSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command",
        `Compress-Archive -Path '${srcDir}\\*' -DestinationPath '${zipPath}' -Force`],
      { stdio: "ignore" }
    );
  } else {
    // zip the directory contents (manifest.json at the archive root).
    execFileSync("zip", ["-r", "-q", zipPath, "."], { cwd: srcDir });
  }
}

function build(target) {
  const outDir = path.join(distRoot, target.name);
  fs.mkdirSync(outDir, { recursive: true });

  for (const item of SHARED) {
    const src = path.join(root, item);
    if (!fs.existsSync(src)) {
      throw new Error(`Missing source file or directory: ${item}`);
    }
    copyRecursive(src, path.join(outDir, item));
  }

  fs.copyFileSync(path.join(root, target.manifest), path.join(outDir, "manifest.json"));

  const zipPath = path.join(distRoot, `${target.name}.zip`);
  zipDir(outDir, zipPath);
  console.log(`Built ${path.relative(root, outDir)} and ${path.relative(root, zipPath)}`);
}

// Start from a clean dist/ so stale folders and zips never linger.
fs.rmSync(distRoot, { recursive: true, force: true });
fs.mkdirSync(distRoot, { recursive: true });

for (const target of TARGETS) {
  build(target);
}
