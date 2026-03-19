#!/usr/bin/env bun
import { homedir, tmpdir } from "os";
import { join } from "path";
import { readdir, readFile, unlink } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { deflateRawSync } from "zlib";
import { createCipheriv, randomBytes, createHash } from "crypto";

// Cache static assets (read once, never change)
let _viewerCss: string | null = null;
let _viewerJs: string | null = null;

// ── Types ────────────────────────────────────────────────────────────

interface Session {
  id: string;
  source: "claude" | "codex" | "opencode";
  project: string;
  title: string;
  timestamp: Date;
  path: string; // file path for claude/codex, session ID for opencode
  messageCount: number;
}

interface Message {
  role: string;
  content: string;
  timestamp: string;
  toolName?: string;
}

interface Conversation {
  title: string;
  source: string;
  project: string;
  timestamp: string;
  messages: Message[];
}

function extractProjectName(dirName: string): string {
  // Dir name encodes path: -Users-sigkitten-dev-foo-bar
  // We want the part after the last common prefix segment
  // Try to find "dev-" and take everything after it as the project name
  const devIdx = dirName.lastIndexOf("-dev-");
  if (devIdx !== -1) {
    return dirName.slice(devIdx + 5); // after "-dev-"
  }
  // Fallback: last segment after -
  return dirName.split("-").filter(Boolean).pop() || dirName;
}

// ── Session discovery (streaming) ────────────────────────────────────

type OnSession = (session: Session) => void;

async function streamClaudeSessions(onSession: OnSession) {
  const dir = join(homedir(), ".claude", "projects");
  if (!existsSync(dir)) return;

  const projects = await readdir(dir, { withFileTypes: true });

  // Process all projects in parallel
  await Promise.all(projects.filter(p => p.isDirectory()).map(async (proj) => {
    const projPath = join(dir, proj.name);
    const projName = proj.name;
    let files: string[];
    try { files = await readdir(projPath); } catch { return; }

    const batch = files
      .filter((f) => f.endsWith(".jsonl"))
      .map(async (file) => {
        const filePath = join(projPath, file);
        try {
          const sessionId = file.replace(".jsonl", "");
          const content = await readFile(filePath, "utf-8");
          const lines = content.split("\n");

          let timestamp: Date | null = null;
          let firstUserMsg = "";
          let msgCount = 0;

          for (const line of lines) {
            if (!line) continue;
            let v: any;
            try { v = JSON.parse(line); } catch { continue; }

            const type = v.type;
            if (type === "user" || type === "assistant") msgCount++;

            if (!timestamp && v.timestamp) {
              const d = new Date(v.timestamp);
              if (!isNaN(d.getTime())) timestamp = d;
            }

            if (!firstUserMsg && type === "user" && v.message?.content) {
              const c = v.message.content;
              if (typeof c === "string") {
                firstUserMsg = c.slice(0, 80);
              } else if (Array.isArray(c)) {
                const txt = c.find((x: any) => x.type === "text");
                if (txt?.text) firstUserMsg = txt.text.slice(0, 80);
              }
            }
          }

          if (msgCount < 2) return;

          // Dir is like -Users-sigkitten-dev-foo-bar → try to get project name after last known path part
          const prettyProject = extractProjectName(projName);
          onSession({
            id: sessionId,
            source: "claude",
            project: prettyProject,
            title: firstUserMsg || "(no title)",
            timestamp: timestamp || new Date(0),
            path: filePath,
            messageCount: msgCount,
          });
        } catch {}
      });

    await Promise.all(batch);
  }));
}

async function streamCodexSessions(onSession: OnSession) {
  const codexDir = join(homedir(), ".codex");
  if (!existsSync(codexDir)) return;

  const indexMap = new Map<string, string>();
  const indexPath = join(codexDir, "session_index.jsonl");
  if (existsSync(indexPath)) {
    const content = await readFile(indexPath, "utf-8");
    for (const line of content.split("\n").filter(Boolean)) {
      try {
        const e = JSON.parse(line);
        if (e.id && e.thread_name) indexMap.set(e.id, e.thread_name);
      } catch {}
    }
  }

  const sessionsDir = join(codexDir, "sessions");
  if (!existsSync(sessionsDir)) return;

  const paths: string[] = [];
  await walkJsonl(sessionsDir, async (filePath) => {
    const fname = filePath.split("/").pop()!;
    if (fname.startsWith("rollout-")) {
      paths.push(filePath);
    }
  });

  const batch = paths.map(async (filePath) => {
    const fname = filePath.split("/").pop()!;
    const sessionId = fname.replace("rollout-", "").replace(".jsonl", "");
    const parts = sessionId.split("-");
    const uuid = parts.length >= 5 ? parts.slice(-5).join("-") : sessionId;

    try {
      const content = await readFile(filePath, "utf-8");
      let timestamp: Date | null = null;
      let msgCount = 0;
      let cwd = "";

      for (const line of content.split("\n")) {
        if (!line) continue;
        let v: any;
        try { v = JSON.parse(line); } catch { continue; }

        if (!timestamp && v.timestamp) {
          const d = new Date(v.timestamp);
          if (!isNaN(d.getTime())) timestamp = d;
        }
        if (v.type === "session_meta") cwd = v.payload?.cwd || "";
        if (v.type === "response_item") {
          const role = v.payload?.role;
          if (role === "user" || role === "assistant") msgCount++;
        }
      }

      if (msgCount < 2) return;

      onSession({
        id: uuid,
        source: "codex",
        project: cwd,
        title: indexMap.get(uuid) || "(untitled)",
        timestamp: timestamp || new Date(0),
        path: filePath,
        messageCount: msgCount,
      });
    } catch {}
  });

  await Promise.all(batch);
}

// ── OpenCode sessions (SQLite) ────────────────────────────────────

function getOpencodeDbPath(): string {
  const xdg = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(xdg, "opencode", "opencode.db");
}

async function streamOpencodeSessions(onSession: OnSession) {
  const dbPath = getOpencodeDbPath();
  if (!existsSync(dbPath)) return;

  try {
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath, { readonly: true });

    const rows = db.query(`
      SELECT s.id, s.title, s.directory, s.time_created, s.time_updated,
             COUNT(m.id) as msg_count
      FROM session s
      LEFT JOIN message m ON m.session_id = s.id
      GROUP BY s.id
      HAVING msg_count >= 2
      ORDER BY s.time_updated DESC
    `).all() as any[];

    for (const row of rows) {
      const project = row.directory?.split("/").pop() || row.directory || "";
      onSession({
        id: row.id,
        source: "opencode",
        project,
        title: row.title || "(untitled)",
        timestamp: new Date(row.time_updated || row.time_created || 0),
        path: row.id, // store session ID as path
        messageCount: row.msg_count,
      });
    }

    db.close();
  } catch {}
}

async function parseOpencodeConversation(sessionId: string): Promise<Conversation> {
  const { Database } = await import("bun:sqlite");
  const db = new Database(getOpencodeDbPath(), { readonly: true });

  const session = db.query(`SELECT * FROM session WHERE id = ?`).get(sessionId) as any;

  const msgs = db.query(`
    SELECT id, data, time_created FROM message
    WHERE session_id = ? ORDER BY time_created
  `).all(sessionId) as any[];

  const partsQuery = db.query(`
    SELECT data FROM part WHERE message_id = ? ORDER BY time_created
  `);

  const messages: Message[] = [];
  let firstUserMsg = "";

  for (const msg of msgs) {
    const msgData = typeof msg.data === "string" ? JSON.parse(msg.data) : msg.data;
    const role = msgData.role;
    const ts = new Date(msg.time_created).toISOString();

    const parts = partsQuery.all(msg.id) as any[];
    for (const row of parts) {
      let part: any;
      try { part = typeof row.data === "string" ? JSON.parse(row.data) : row.data; } catch { continue; }

      if (part.type === "text" && part.text?.trim()) {
        if (role === "user" && !firstUserMsg) firstUserMsg = part.text.slice(0, 80);
        messages.push({ role, content: part.text, timestamp: ts });
      } else if (part.type === "tool") {
        const toolName = part.tool || "tool";
        const input = part.state?.input ? JSON.stringify(part.state.input, null, 2) : "";
        const output = part.state?.output?.trim() || "";
        let content = `[Tool: ${toolName}]`;
        if (input) content += `\n${input}`;
        if (output) content += `\n\n${output}`;
        messages.push({ role: "assistant", content, timestamp: ts, toolName });
      }
    }
  }

  db.close();

  return {
    title: session?.title || firstUserMsg || "OpenCode Session",
    source: "OpenCode",
    project: session?.directory || "",
    timestamp: session ? new Date(session.time_created).toISOString() : "",
    messages,
  };
}

async function walkJsonl(dir: string, cb: (path: string) => Promise<void>) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walkJsonl(p, cb);
    else if (e.name.endsWith(".jsonl")) await cb(p);
  }
}

// ── Conversation parsing ─────────────────────────────────────────────

async function parseClaudeConversation(path: string): Promise<Conversation> {
  const content = await readFile(path, "utf-8");
  const messages: Message[] = [];
  let firstUserMsg = "";
  let sessionTs = "";
  let project = "";

  for (const line of content.split("\n").filter(Boolean)) {
    let v: any;
    try { v = JSON.parse(line); } catch { continue; }

    if (!sessionTs && v.timestamp) sessionTs = v.timestamp;
    if (!project && v.cwd) project = v.cwd;

    const ts = v.timestamp || "";

    if (v.type === "user") {
      const text = extractClaudeContent(v.message?.content);
      if (!firstUserMsg) firstUserMsg = text.slice(0, 80);
      if (text.trim()) messages.push({ role: "user", content: text, timestamp: ts });
    } else if (v.type === "assistant" && Array.isArray(v.message?.content)) {
      for (const item of v.message.content) {
        if (item.type === "text" && item.text?.trim()) {
          messages.push({ role: "assistant", content: item.text, timestamp: ts });
        } else if (item.type === "tool_use") {
          messages.push({
            role: "assistant",
            content: `[Tool: ${item.name}]\n${JSON.stringify(item.input, null, 2)}`,
            timestamp: ts,
            toolName: item.name,
          });
        }
      }
    }
  }

  return {
    title: firstUserMsg || "Claude Code Session",
    source: "Claude Code",
    project,
    timestamp: sessionTs,
    messages,
  };
}

function extractClaudeContent(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((x: any) => x.type === "text" && x.text)
      .map((x: any) => x.text)
      .join("\n");
  }
  return "";
}

async function parseCodexConversation(path: string): Promise<Conversation> {
  const content = await readFile(path, "utf-8");
  const messages: Message[] = [];
  let sessionTs = "";
  let cwd = "";
  let title = "";

  for (const line of content.split("\n").filter(Boolean)) {
    let v: any;
    try { v = JSON.parse(line); } catch { continue; }

    const ts = v.timestamp || "";
    if (!sessionTs && ts) sessionTs = ts;

    if (v.type === "session_meta") cwd = v.payload?.cwd || "";
    if (v.type === "response_item") {
      const role = v.payload?.role;
      const items = v.payload?.content;
      if (!Array.isArray(items)) continue;

      for (const item of items) {
        if (item.type === "input_text" && role === "user") {
          const text = item.text || "";
          if (text.includes("<permissions instructions>") || text.includes("<instructions>")) continue;
          if (!text.trim()) continue;
          if (!title) title = text.slice(0, 80);
          messages.push({ role: "user", content: text, timestamp: ts });
        } else if (item.type === "output_text" && role === "assistant") {
          if (item.text?.trim()) {
            messages.push({ role: "assistant", content: item.text, timestamp: ts });
          }
        }
      }
    }
  }

  return {
    title: title || "Codex Session",
    source: "Codex",
    project: cwd,
    timestamp: sessionTs,
    messages,
  };
}

async function parseSession(session: Session): Promise<Conversation> {
  if (session.source === "claude") return parseClaudeConversation(session.path);
  if (session.source === "opencode") return parseOpencodeConversation(session.path);
  return parseCodexConversation(session.path);
}

// ── HTML generation ──────────────────────────────────────────────────

function generateHtml(conv: Conversation): string {
  // Escape </script> so it doesn't close the JSON tag
  const jsonData = JSON.stringify(conv).replace(/<\//g, "<\\/");
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(conv.title)}</title>
<style>${getViewerCss()}</style>
</head>
<body>
${getAppShell()}
<script id="data" type="application/json">${jsonData}</script>
<script>${getViewerScript()}</script>
<script>renderApp(JSON.parse(document.getElementById('data').textContent));</script>
</body>
</html>`;
}

function getAppShell(): string {
  return `<button id="hamburger" title="Open sidebar">&#9776;</button>
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
    <footer>clanker-share</footer>
  </main>
</div>`;
}

function getViewerCss(): string {
  return (_viewerCss ??= readFileSync(join(import.meta.dir, "viewer.css"), "utf-8"));
}

function getViewerScript(): string {
  return (_viewerJs ??= readFileSync(join(import.meta.dir, "viewer.js"), "utf-8"));
}

// ── Share (encrypted gist) ───────────────────────────────────────────

const shareCache = new Map<string, ShareResult>();

interface ShareResult {
  publicUrl: string;  // share.clanker.monster/#<gist-id> (needs key separately)
  privateUrl: string; // share.clanker.monster/#<gist-id>.<key>
  key: string;        // base64url key
}

async function getSessionRaw(session: Session): Promise<string> {
  if (session.source === "opencode") {
    // Export opencode session as JSON for sharing
    const conv = await parseOpencodeConversation(session.path);
    return JSON.stringify(conv);
  }
  return await readFile(session.path, "utf-8");
}

async function generateShareUrl(session: Session): Promise<ShareResult> {
  const raw = await getSessionRaw(session);

  // Compress → encrypt → upload to private gist
  const compressed = deflateRawSync(Buffer.from(raw), { level: 9 });

  // AES-256-GCM with random 128-bit key
  const key = randomBytes(16);
  const aesKey = createHash("sha256").update(key).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", aesKey, iv);
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Pack: iv(12) + ciphertext + authTag(16) — WebCrypto expects tag appended
  const packed = Buffer.concat([iv, encrypted, authTag]);

  // Upload to GitHub gist
  const tmpFile = join(tmpdir(), `clanker-share-${Date.now()}.bin`);
  await Bun.write(tmpFile, packed.toString("base64"));

  const proc = Bun.spawn(["gh", "gist", "create", "--public=false", tmpFile], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;

  try { await unlink(tmpFile); } catch {}

  if (proc.exitCode !== 0) {
    throw new Error(`gh gist create failed: ${stderr.trim()}`);
  }

  const gistUrl = stdout.trim();
  const gistId = gistUrl.split("/").pop();
  if (!gistId) throw new Error(`couldn't parse gist ID from: ${gistUrl}`);

  const keyB64 = key.toString("base64url");
  const base = `https://share.clanker.monster/#${gistId}`;

  return {
    publicUrl: base,
    privateUrl: `${base}.${keyB64}`,
    key: keyB64,
  };
}

// ── TUI ──────────────────────────────────────────────────────────────

const ESC = "\x1b";
const CSI = `${ESC}[`;

const ansi = {
  clear: `${CSI}2J${CSI}H`,
  hideCursor: `${CSI}?25l`,
  showCursor: `${CSI}?25h`,
  moveTo: (r: number, c: number) => `${CSI}${r};${c}H`,
  eraseLine: `${CSI}2K`,
  bold: `${CSI}1m`,
  dim: `${CSI}2m`,
  italic: `${CSI}3m`,
  reset: `${CSI}0m`,
  inverse: `${CSI}7m`,
  fg: (n: number) => `${CSI}38;5;${n}m`,
  bg: (n: number) => `${CSI}48;5;${n}m`,
  altScreen: `${CSI}?1049h`,
  mainScreen: `${CSI}?1049l`,
};

function write(s: string) {
  process.stdout.write(s);
}

function getTermSize(): { rows: number; cols: number } {
  return { rows: process.stdout.rows || 24, cols: process.stdout.columns || 80 };
}

// Truncate/pad string to exact width
function fit(s: string, w: number): string {
  if (s.length > w) return s.slice(0, w - 1) + "…";
  return s + " ".repeat(w - s.length);
}

interface TuiState {
  sessions: Session[];
  filtered: Session[];
  cursor: number;
  scroll: number;
  search: string;
  searching: boolean;
  status: string;
  statusTimeout?: ReturnType<typeof setTimeout>;
  lastShare?: ShareResult;
}

// Fuzzy match: returns score (higher = better), -1 = no match
function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let prevMatch = -2;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += 1;
      // Bonus for consecutive matches
      if (ti === prevMatch + 1) score += 3;
      // Bonus for matching at word boundaries
      if (ti === 0 || t[ti - 1] === " " || t[ti - 1] === "/" || t[ti - 1] === "-" || t[ti - 1] === "_") score += 5;
      prevMatch = ti;
      qi++;
    }
  }

  return qi === q.length ? score : -1;
}

function filterSessions(sessions: Session[], query: string): Session[] {
  if (!query) return sessions;

  const words = query.split(/\s+/).filter(Boolean);
  if (!words.length) return sessions;

  const scored = sessions
    .map((s) => {
      const haystack = `${s.title} ${s.project} ${s.source}`;
      let total = 0;
      for (const word of words) {
        const sc = fuzzyScore(word, haystack);
        if (sc < 0) return { session: s, score: -1 };
        total += sc;
      }
      return { session: s, score: total };
    })
    .filter((x) => x.score >= 0);

  scored.sort((a, b) => b.score - a.score);
  return scored.map((x) => x.session);
}

function render(state: TuiState) {
  const { cols, rows } = getTermSize();
  const listHeight = rows - 5; // header(2) + footer(2) + search(1)

  write(ansi.clear);

  // Header
  write(ansi.moveTo(1, 1));
  write(`${ansi.bold}${ansi.fg(255)} clanker-share${ansi.reset}`);
  write(`${ansi.dim}${ansi.fg(240)}  ${state.filtered.length} sessions${ansi.reset}`);

  // Column headers
  write(ansi.moveTo(2, 1));
  const srcW = 9;
  const projW = 14;
  const idW = 10;
  const msgW = 6;
  const dateW = 11;
  const titleW = Math.max(20, cols - srcW - projW - idW - msgW - dateW - 7);
  write(
    `${ansi.dim}${ansi.fg(242)}` +
    `${fit("SOURCE", srcW)} ${fit("PROJECT", projW)} ${fit("TITLE", titleW)} ${fit("ID", idW)} ${fit("MSGS", msgW)} ${fit("DATE", dateW)}` +
    `${ansi.reset}`
  );

  // List
  const visible = state.filtered.slice(state.scroll, state.scroll + listHeight);
  for (let i = 0; i < listHeight; i++) {
    write(ansi.moveTo(3 + i, 1));
    write(ansi.eraseLine);
    const session = visible[i];
    if (!session) continue;

    const idx = state.scroll + i;
    const selected = idx === state.cursor;

    const srcColor = session.source === "claude" ? ansi.fg(141) : session.source === "opencode" ? ansi.fg(214) : ansi.fg(71);
    const project = session.project.split("/").pop() || session.project;
    const shortId = session.id.slice(0, 8);
    const date = session.timestamp.getTime() > 0
      ? session.timestamp.toISOString().slice(0, 10)
      : "";
    const msgs = session.messageCount > 0 ? String(session.messageCount) : "";

    if (selected) {
      write(`${ansi.bg(236)}${ansi.fg(255)}`);
    }

    write(
      `${selected ? "" : srcColor}${fit(session.source, srcW)}${selected ? "" : ansi.reset}` +
      `${selected ? "" : ansi.fg(245)} ` +
      `${fit(project, projW)} ` +
      `${selected ? "" : ansi.fg(250)}${fit(session.title, titleW)} ` +
      `${selected ? "" : ansi.fg(239)}${fit(shortId, idW)} ` +
      `${selected ? "" : ansi.dim}${fit(msgs, msgW)} ` +
      `${fit(date, dateW)}` +
      `${ansi.reset}`
    );
  }

  // Search bar
  const searchRow = rows - 2;
  write(ansi.moveTo(searchRow, 1));
  write(ansi.eraseLine);
  if (state.searching) {
    write(`${ansi.fg(245)}/${ansi.reset}${ansi.fg(255)}${state.search}${ansi.reset}`);
    write(`${ansi.showCursor}`);
  } else if (state.search) {
    write(`${ansi.dim}/${state.search}${ansi.reset}`);
  }

  // Footer
  write(ansi.moveTo(rows - 1, 1));
  write(ansi.eraseLine);
  if (state.status) {
    write(`${ansi.fg(250)}${state.status}${ansi.reset}`);
  } else {
    write(
      `${ansi.dim}${ansi.fg(242)}` +
      `↑↓ navigate  / search  s share  c copy private  o open  q quit` +
      `${ansi.reset}`
    );
  }

  if (!state.searching) write(ansi.hideCursor);
}

function setStatus(state: TuiState, msg: string, ms = 3000) {
  if (state.statusTimeout) clearTimeout(state.statusTimeout);
  state.status = msg;
  render(state);
  state.statusTimeout = setTimeout(() => {
    state.status = "";
    render(state);
  }, ms);
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["pbcopy"], { stdin: "pipe" });
    proc.stdin.write(text);
    proc.stdin.end();
    await proc.exited;
    return true;
  } catch {
    return false;
  }
}

async function openInBrowser(path: string) {
  Bun.spawn(["open", path]);
}

async function runTui() {
  write(ansi.altScreen);
  write(ansi.hideCursor);

  // Enable raw mode
  if (!process.stdin.isTTY) {
    console.error("error: not a TTY — run interactively");
    process.exit(1);
  }
  process.stdin.setRawMode!(true);
  process.stdin.resume();

  const state: TuiState = {
    sessions: [],
    filtered: [],
    cursor: 0,
    scroll: 0,
    search: "",
    searching: false,
    status: "loading...",
  };

  render(state);

  // Stream sessions in — re-sort and re-render on each batch tick
  let dirty = false;

  const onSession = (s: Session) => {
    state.sessions.push(s);
    dirty = true;
  };

  // Flush dirty state to screen periodically while loading
  const flushInterval = setInterval(() => {
    if (!dirty) return;
    dirty = false;
    state.sessions.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    state.filtered = filterSessions(state.sessions, state.search);
    state.status = `loading... ${state.sessions.length}`;
    render(state);
  }, 50);

  // Kick off both in parallel
  Promise.all([
    streamClaudeSessions(onSession),
    streamCodexSessions(onSession),
    streamOpencodeSessions(onSession),
  ]).then(() => {
    clearInterval(flushInterval);
    // Final flush
    state.sessions.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    state.filtered = filterSessions(state.sessions, state.search);
    state.status = "";
    render(state);
  }).catch(() => {});

  const cleanup = () => {
    write(ansi.showCursor);
    write(ansi.mainScreen);
    process.stdin.setRawMode(false);
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Handle resize
  process.stdout.on("resize", () => render(state));

  const ensureVisible = () => {
    const { rows } = getTermSize();
    const listHeight = rows - 5;
    if (state.cursor < state.scroll) state.scroll = state.cursor;
    if (state.cursor >= state.scroll + listHeight) state.scroll = state.cursor - listHeight + 1;
  };

  const updateFilter = () => {
    state.filtered = filterSessions(state.sessions, state.search);
    state.cursor = 0;
    state.scroll = 0;
  };

  process.stdin.on("data", async (chunk: Buffer) => {
    const key = chunk.toString();

    if (state.searching) {
      if (key === "\r" || key === "\n" || key === ESC) {
        // Exit search
        state.searching = false;
        render(state);
      } else if (key === "\x7f" || key === "\b") {
        // Backspace
        state.search = state.search.slice(0, -1);
        updateFilter();
        render(state);
      } else if (key === "\x15") {
        // Ctrl+U clear
        state.search = "";
        updateFilter();
        render(state);
      } else if (key.length === 1 && key.charCodeAt(0) >= 32) {
        state.search += key;
        updateFilter();
        render(state);
      }
      return;
    }

    // Normal mode
    if (key === "q" || key === "\x03") {
      cleanup();
    } else if (key === "/" || key === "f") {
      state.searching = true;
      render(state);
    } else if (key === "j" || key === `${CSI}B`) {
      // Down
      if (state.cursor < state.filtered.length - 1) {
        state.cursor++;
        ensureVisible();
        render(state);
      }
    } else if (key === "k" || key === `${CSI}A`) {
      // Up
      if (state.cursor > 0) {
        state.cursor--;
        ensureVisible();
        render(state);
      }
    } else if (key === "g") {
      // Top
      state.cursor = 0;
      ensureVisible();
      render(state);
    } else if (key === "G") {
      // Bottom
      state.cursor = Math.max(0, state.filtered.length - 1);
      ensureVisible();
      render(state);
    } else if (key === "s") {
      // Share: encrypt & upload, copy private URL (with key)
      const session = state.filtered[state.cursor];
      if (!session) return;
      // Check cache
      const cached = shareCache.get(session.path);
      if (cached) {
        const ok = await copyToClipboard(cached.privateUrl);
        setStatus(state, ok ? `copied! key: ${cached.key}` : "clipboard failed", 8000);
        state.lastShare = cached;
      } else {
        setStatus(state, "encrypting & uploading...");
        try {
          const share = await generateShareUrl(session);
          shareCache.set(session.path, share);
          state.lastShare = share;
          const ok = await copyToClipboard(share.privateUrl);
          setStatus(state, ok ? `copied! key: ${share.key}` : "clipboard failed", 8000);
        } catch (e: any) {
          setStatus(state, `error: ${e.message}`);
        }
      }
    } else if (key === "c") {
      // Copy public URL (without key) from last share
      if (!state.lastShare) {
        setStatus(state, "press s first to share");
      } else {
        const ok = await copyToClipboard(state.lastShare.publicUrl);
        setStatus(state, ok ? "public url copied (no key)" : "clipboard failed");
      }
    } else if (key === "o") {
      // Open in browser
      const session = state.filtered[state.cursor];
      if (!session) return;
      setStatus(state, "opening...");
      try {
        const conv = await parseSession(session);
        const html = generateHtml(conv);
        const tmp = join(
          tmpdir(),
          `clanker-${session.id.slice(0, 8)}.html`
        );
        await Bun.write(tmp, html);
        await openInBrowser(tmp);
        setStatus(state, `opened ${tmp}`);
      } catch (e: any) {
        setStatus(state, `error: ${e.message}`);
      }
    } else if (key === "\r" || key === "\n") {
      // Enter = export to file
      const session = state.filtered[state.cursor];
      if (!session) return;
      setStatus(state, "exporting...");
      try {
        const conv = await parseSession(session);
        const html = generateHtml(conv);
        const outPath = `${session.id.slice(0, 8)}.html`;
        await Bun.write(outPath, html);
        setStatus(state, `saved ${outPath}`);
      } catch (e: any) {
        setStatus(state, `error: ${e.message}`);
      }
    } else if (key === ESC) {
      // Clear search
      if (state.search) {
        state.search = "";
        updateFilter();
        render(state);
      }
    }
  });
}

// ── Entry point ──────────────────────────────────────────────────────

runTui().catch((e) => {
  write(ansi.showCursor);
  write(ansi.mainScreen);
  console.error(e);
  process.exit(1);
});
