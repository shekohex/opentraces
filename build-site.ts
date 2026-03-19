#!/usr/bin/env bun
// Build site/index.html from template + shared viewer.css/viewer.js
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const dir = import.meta.dir;

const template = readFileSync(join(dir, "site-template.html"), "utf-8");
const css = readFileSync(join(dir, "viewer.css"), "utf-8");
const js = readFileSync(join(dir, "viewer.js"), "utf-8");

// Build the app shell (same as getAppShell() in index.ts)
const shell = `<button id="hamburger" title="Open sidebar">&#9776;</button>
<div id="sidebar-overlay"></div>
<div id="app">
  <aside id="sidebar">
    <div class="sidebar-header">
      <div class="sidebar-controls">
        <input type="text" class="sidebar-search" id="tree-search" placeholder="Search...">
      </div>
      <div class="sidebar-filters">
        <button class="filter-btn active" data-filter="default">Default</button>
        <button class="filter-btn" data-filter="no-tools">No tools</button>
        <button class="filter-btn" data-filter="user">User</button>
        <button class="filter-btn" data-filter="all">All</button>
        <button class="sidebar-close" id="sidebar-close">&times;</button>
      </div>
    </div>
    <div class="tree-container" id="tree-container"></div>
    <div class="tree-status" id="tree-status"></div>
  </aside>
  <main id="content">
    <div class="page-header" id="page-header"></div>
    <div class="thread" id="thread"></div>
    <footer>share.clanker.monster</footer>
  </main>
</div>`;

const output = template
  .replace("{{CSS}}", css)
  .replace("{{SHELL}}", shell)
  .replace("{{VIEWER_JS}}", js);

mkdirSync(join(dir, "site"), { recursive: true });
writeFileSync(join(dir, "site", "index.html"), output);
console.log("built site/index.html (" + output.length + " bytes)");

// Generate OG image if resvg is available
try {
  const { execSync } = await import("child_process");
  execSync("bun run generate-og.ts", { cwd: dir, stdio: "inherit" });
} catch {
  console.log("skipped og image generation");
}
