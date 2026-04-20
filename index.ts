#!/usr/bin/env node
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { getPublicBaseUrl } from "./public-url.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));

// Cache static assets (read once, never change)
let _viewerCss: string | null = null;
let _viewerJs: string | null = null;
let _viewerConfig: ViewerConfig | null = null;

const opentracesDir = join(homedir(), ".opentraces");
const viewerConfigPath = join(opentracesDir, "config.json");

// ── Types ────────────────────────────────────────────────────────────

interface Session {
  id: string;
  source: "claude" | "codex" | "opencode" | "pi";
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
  modelId?: string;
}

interface Conversation {
  title: string;
  source: string;
  project: string;
  timestamp: string;
  modelId?: string;
  messages: Message[];
}

interface ViewerConfig {
  userLabel: string;
  userAvatarUrl: string;
  assistantFallbackLabel: string;
  githubUsername: string;
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

interface PiSessionHeader {
  type: "session";
  id: string;
  timestamp?: string;
  cwd?: string;
}

interface PiSessionEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  [key: string]: any;
}

function parseJsonLines(content: string): any[] {
  const entries: any[] = [];
  for (const line of content.split("\n")) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {}
  }
  return entries;
}

function extractTextFromBlocks(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((x: any) => x && x.type === "text" && typeof x.text === "string")
      .map((x: any) => x.text)
      .join("\n");
  }
  return "";
}

function normalizeModelId(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const normalized = normalizeModelId(value);
    if (normalized) return normalized;
  }
  return "";
}

function readModelId(value: any): string {
  if (!value || typeof value !== "object") return "";

  const direct = firstString(
    value.modelId,
    value.model_id,
    value.model,
    value.assistantModel,
    value.assistant_model,
    value.responseModel,
    value.response_model,
  );
  if (direct) return direct;

  const nested = firstString(
    value.model?.id,
    value.model?.name,
    value.model_info?.id,
    value.model_info?.name,
    value.payload?.model,
    value.payload?.model_id,
    value.payload?.modelId,
    value.payload?.model?.id,
    value.payload?.model?.name,
    value.message?.model,
    value.message?.model_id,
    value.message?.modelId,
  );
  return nested;
}

function getConversationModel(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    if (message.role === "assistant" && message.modelId) return message.modelId;
  }
  return "";
}

function getDefaultViewerConfig(): ViewerConfig {
  return {
    userLabel: "user",
    userAvatarUrl: "",
    assistantFallbackLabel: "assistant",
    githubUsername: "",
  };
}

async function loadViewerConfig(): Promise<ViewerConfig> {
  if (_viewerConfig) return _viewerConfig;

  const defaults = getDefaultViewerConfig();

  try {
    const raw = await readFile(viewerConfigPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ViewerConfig>;
    _viewerConfig = {
      userLabel: typeof parsed.userLabel === "string" && parsed.userLabel.trim() ? parsed.userLabel.trim().slice(0, 80) : defaults.userLabel,
      userAvatarUrl: typeof parsed.userAvatarUrl === "string" ? parsed.userAvatarUrl.trim().slice(0, 500) : defaults.userAvatarUrl,
      assistantFallbackLabel: typeof parsed.assistantFallbackLabel === "string" && parsed.assistantFallbackLabel.trim()
        ? parsed.assistantFallbackLabel.trim().slice(0, 80)
        : defaults.assistantFallbackLabel,
      githubUsername: typeof parsed.githubUsername === "string" ? parsed.githubUsername.trim().replace(/^@/, "").slice(0, 80) : defaults.githubUsername,
    };
    return _viewerConfig;
  } catch {
    _viewerConfig = defaults;
    return _viewerConfig;
  }
}

function parsePiSessionFile(content: string): { header: PiSessionHeader | null; entries: PiSessionEntry[] } {
  const parsed = parseJsonLines(content);
  const header = parsed.find((e: any) => e?.type === "session" && typeof e.id === "string") as PiSessionHeader | undefined;
  const entries = parsed.filter((e: any) => e?.type !== "session") as PiSessionEntry[];
  return { header: header || null, entries };
}

function buildPiPath(entries: PiSessionEntry[]): PiSessionEntry[] {
  const byId = new Map<string, PiSessionEntry>();
  for (const entry of entries) {
    if (typeof entry.id === "string") byId.set(entry.id, entry);
  }

  let leaf: PiSessionEntry | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (typeof entries[i]?.id === "string") {
      leaf = entries[i];
      break;
    }
  }

  if (!leaf) return entries;

  const path: PiSessionEntry[] = [];
  const seen = new Set<string>();
  let current: PiSessionEntry | undefined = leaf;

  while (current && typeof current.id === "string" && !seen.has(current.id)) {
    path.unshift(current);
    seen.add(current.id);
    const parentId = current.parentId;
    if (typeof parentId !== "string") break;
    current = byId.get(parentId);
  }

  return path.length > 0 ? path : entries;
}

function getPiSessionName(pathEntries: PiSessionEntry[]): string {
  for (let i = pathEntries.length - 1; i >= 0; i--) {
    const entry = pathEntries[i];
    if (!entry) continue;
    if (entry.type === "session_info") {
      const name = typeof entry.name === "string" ? entry.name.trim() : "";
      return name;
    }
  }
  return "";
}

function convertPiEntriesToMessages(pathEntries: PiSessionEntry[]): { messages: Message[]; firstUserMsg: string } {
  const messages: Message[] = [];
  let firstUserMsg = "";
  let currentModelId = "";

  const pushUser = (text: string, ts: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!firstUserMsg) firstUserMsg = trimmed.slice(0, 80);
    messages.push({ role: "user", content: trimmed, timestamp: ts });
  };

  const pushAssistant = (text: string, ts: string, toolName?: string, modelId?: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const resolvedModelId = firstString(modelId, currentModelId);
    if (toolName) messages.push({ role: "assistant", content: trimmed, timestamp: ts, toolName, modelId: resolvedModelId || undefined });
    else messages.push({ role: "assistant", content: trimmed, timestamp: ts, modelId: resolvedModelId || undefined });
  };

  for (const entry of pathEntries) {
    const ts = typeof entry.timestamp === "string" ? entry.timestamp : "";

    if (entry.type === "model_change") {
      currentModelId = firstString(
        entry.modelId,
        entry.model_id,
        entry.model,
        entry.to,
        entry.value,
        entry.next,
      ) || currentModelId;
      continue;
    }

    if (entry.type === "message" && entry.message) {
      const msg = entry.message;
      const role = msg.role;
      const messageModelId = firstString(readModelId(entry), readModelId(msg), currentModelId);
      if (messageModelId) currentModelId = messageModelId;

      if (role === "user") {
        pushUser(extractTextFromBlocks(msg.content), ts);
        continue;
      }

      if (role === "assistant") {
        const content = msg.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (!block) continue;
            if (block.type === "text" && typeof block.text === "string") {
              pushAssistant(block.text, ts, undefined, messageModelId);
            } else if (block.type === "toolCall") {
              const name = typeof block.name === "string" ? block.name : "tool";
              const argsText = block.arguments !== undefined ? `\n${JSON.stringify(block.arguments, null, 2)}` : "";
              pushAssistant(`[Tool: ${name}]${argsText}`, ts, name, messageModelId);
            }
          }
        } else {
          pushAssistant(extractTextFromBlocks(content), ts, undefined, messageModelId);
        }
        continue;
      }

      if (role === "toolResult") {
        const toolName = typeof msg.toolName === "string" ? msg.toolName : "tool";
        const text = extractTextFromBlocks(msg.content) || "(no output)";
        pushAssistant(text, ts, toolName, messageModelId);
        continue;
      }

      if (role === "bashExecution") {
        const command = typeof msg.command === "string" ? msg.command : "bash";
        const output = typeof msg.output === "string" ? msg.output : "";
        const body = output.trim() ? `Ran \`${command}\`\n\n${output}` : `Ran \`${command}\``;
        pushAssistant(body, ts, "bash", messageModelId);
        continue;
      }

      if (role === "custom") {
        const customType = typeof msg.customType === "string" ? msg.customType : "custom";
        pushAssistant(extractTextFromBlocks(msg.content), ts, customType, messageModelId);
        continue;
      }

      if (role === "branchSummary" && typeof msg.summary === "string") {
        pushAssistant(`[Branch Summary]\n${msg.summary}`, ts);
        continue;
      }

      if (role === "compactionSummary" && typeof msg.summary === "string") {
        pushAssistant(`[Compaction Summary]\n${msg.summary}`, ts);
        continue;
      }
    }

    if (entry.type === "custom_message") {
      if (entry.display === false) continue;
      const customType = typeof entry.customType === "string" ? entry.customType : "custom";
      pushAssistant(extractTextFromBlocks(entry.content), ts, customType);
      continue;
    }

    if (entry.type === "branch_summary" && typeof entry.summary === "string") {
      pushAssistant(`[Branch Summary]\n${entry.summary}`, ts);
      continue;
    }

    if (entry.type === "compaction" && typeof entry.summary === "string") {
      pushAssistant(`[Compaction Summary]\n${entry.summary}`, ts);
      continue;
    }
  }

  return { messages, firstUserMsg };
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

async function streamPiSessions(onSession: OnSession) {
  const sessionsDir = join(homedir(), ".pi", "agent", "sessions");
  if (!existsSync(sessionsDir)) return;

  const paths: string[] = [];
  await walkJsonl(sessionsDir, async (filePath) => {
    paths.push(filePath);
  });

  const batch = paths.map(async (filePath) => {
    try {
      const content = await readFile(filePath, "utf-8");
      const { header, entries } = parsePiSessionFile(content);
      if (!header) return;

      const pathEntries = buildPiPath(entries);
      const { messages, firstUserMsg } = convertPiEntriesToMessages(pathEntries);
      if (messages.length < 2) return;

      const sessionName = getPiSessionName(pathEntries);
      const title = (sessionName || firstUserMsg || "(untitled)").slice(0, 80);
      const timestamp = header.timestamp ? new Date(header.timestamp) : new Date(0);

      onSession({
        id: header.id,
        source: "pi",
        project: header.cwd || "",
        title,
        timestamp: isNaN(timestamp.getTime()) ? new Date(0) : timestamp,
        path: filePath,
        messageCount: messages.length,
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
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });

    const rows = db.prepare(`
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
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(getOpencodeDbPath(), { readOnly: true });

  const session = db.prepare(`SELECT * FROM session WHERE id = ?`).get(sessionId) as any;

  const msgs = db.prepare(`
    SELECT id, data, time_created FROM message
    WHERE session_id = ? ORDER BY time_created
  `).all(sessionId) as any[];

  const partsQuery = db.prepare(`
    SELECT data FROM part WHERE message_id = ? ORDER BY time_created
  `);

  const messages: Message[] = [];
  let firstUserMsg = "";
  let currentModelId = "";

  for (const msg of msgs) {
    const msgData = typeof msg.data === "string" ? JSON.parse(msg.data) : msg.data;
    const role = msgData.role;
    const messageModelId = firstString(readModelId(msgData), currentModelId);
    if (messageModelId) currentModelId = messageModelId;
    const ts = new Date(msg.time_created).toISOString();

    const parts = partsQuery.all(msg.id) as any[];
    for (const row of parts) {
      let part: any;
      try { part = typeof row.data === "string" ? JSON.parse(row.data) : row.data; } catch { continue; }

      if (part.type === "text" && part.text?.trim()) {
        if (role === "user" && !firstUserMsg) firstUserMsg = part.text.slice(0, 80);
        if (role === "assistant") {
          const partModelId = firstString(readModelId(part), messageModelId);
          if (partModelId) currentModelId = partModelId;
          messages.push({ role, content: part.text, timestamp: ts, modelId: partModelId || undefined });
        } else {
          messages.push({ role, content: part.text, timestamp: ts });
        }
      } else if (part.type === "tool") {
        const toolName = part.tool || "tool";
        const input = part.state?.input ? JSON.stringify(part.state.input, null, 2) : "";
        const output = part.state?.output?.trim() || "";
        let content = `[Tool: ${toolName}]`;
        if (input) content += `\n${input}`;
        if (output) content += `\n\n${output}`;
        const partModelId = firstString(readModelId(part), messageModelId, currentModelId);
        if (partModelId) currentModelId = partModelId;
        messages.push({ role: "assistant", content, timestamp: ts, toolName, modelId: partModelId || undefined });
      }
    }
  }

  db.close();

  return {
    title: session?.title || firstUserMsg || "OpenCode Session",
    source: "OpenCode",
    project: session?.directory || "",
    timestamp: session ? new Date(session.time_created).toISOString() : "",
    modelId: getConversationModel(messages) || undefined,
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
  let currentModelId = "";

  for (const line of content.split("\n").filter(Boolean)) {
    let v: any;
    try { v = JSON.parse(line); } catch { continue; }

    if (!sessionTs && v.timestamp) sessionTs = v.timestamp;
    if (!project && v.cwd) project = v.cwd;
    const eventModel = readModelId(v);
    if (eventModel) currentModelId = eventModel;

    const ts = v.timestamp || "";

    if (v.type === "user") {
      const text = extractClaudeContent(v.message?.content);
      if (!firstUserMsg) firstUserMsg = text.slice(0, 80);
      if (text.trim()) messages.push({ role: "user", content: text, timestamp: ts });
    } else if (v.type === "assistant" && Array.isArray(v.message?.content)) {
      for (const item of v.message.content) {
        if (item.type === "text" && item.text?.trim()) {
          const itemModel = firstString(readModelId(item), currentModelId);
          if (itemModel) currentModelId = itemModel;
          messages.push({ role: "assistant", content: item.text, timestamp: ts, modelId: itemModel || undefined });
        } else if (item.type === "tool_use") {
          const itemModel = firstString(readModelId(item), currentModelId);
          if (itemModel) currentModelId = itemModel;
          messages.push({
            role: "assistant",
            content: `[Tool: ${item.name}]\n${JSON.stringify(item.input, null, 2)}`,
            timestamp: ts,
            toolName: item.name,
            modelId: itemModel || undefined,
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
    modelId: getConversationModel(messages) || undefined,
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
  let currentModelId = "";

  for (const line of content.split("\n").filter(Boolean)) {
    let v: any;
    try { v = JSON.parse(line); } catch { continue; }

    const ts = v.timestamp || "";
    if (!sessionTs && ts) sessionTs = ts;
    const eventModel = readModelId(v);
    if (eventModel) currentModelId = eventModel;

    if (v.type === "session_meta") cwd = v.payload?.cwd || "";
    if (v.type === "response_item") {
      const role = v.payload?.role;
      const items = v.payload?.content;
      const responseModelId = firstString(readModelId(v.payload), currentModelId);
      if (responseModelId) currentModelId = responseModelId;
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
            const itemModel = firstString(readModelId(item), responseModelId, currentModelId);
            if (itemModel) currentModelId = itemModel;
            messages.push({ role: "assistant", content: item.text, timestamp: ts, modelId: itemModel || undefined });
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
    modelId: getConversationModel(messages) || undefined,
    messages,
  };
}

async function parsePiConversation(path: string): Promise<Conversation> {
  const content = await readFile(path, "utf-8");
  const { header, entries } = parsePiSessionFile(content);
  const pathEntries = buildPiPath(entries);
  const { messages, firstUserMsg } = convertPiEntriesToMessages(pathEntries);
  const sessionName = getPiSessionName(pathEntries);

  return {
    title: sessionName || firstUserMsg || "Pi Session",
    source: "Pi Coding Agent",
    project: header?.cwd || "",
    timestamp: header?.timestamp || "",
    modelId: getConversationModel(messages) || undefined,
    messages,
  };
}

async function parseSession(session: Session): Promise<Conversation> {
  if (session.source === "claude") return parseClaudeConversation(session.path);
  if (session.source === "opencode") return parseOpencodeConversation(session.path);
  if (session.source === "pi") return parsePiConversation(session.path);
  return parseCodexConversation(session.path);
}

// ── HTML generation ──────────────────────────────────────────────────

function generateHtml(conv: Conversation, viewerConfig: ViewerConfig): string {
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
<script>renderApp(JSON.parse(document.getElementById('data').textContent), undefined, ${JSON.stringify(viewerConfig)});</script>
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
    <footer>opentraces</footer>
  </main>
</div>`;
}

function getViewerCss(): string {
  return (_viewerCss ??= readFileSync(join(moduleDir, "viewer.css"), "utf-8"));
}

function getViewerScript(): string {
  return (_viewerJs ??= readFileSync(join(moduleDir, "viewer.js"), "utf-8"));
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runCommand(command: string, args: string[], input?: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode: exitCode ?? 0 });
    });

    if (input !== undefined) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

const MAX_SHARED_SESSION_BYTES = 200 * 1024 * 1024;

interface PublicShareMetadata {
  title: string;
  agent: string;
  messageCount: number;
  modelName?: string;
  modelId?: string;
  githubUsername?: string;
}

interface UploadSessionResponse {
  id: string;
  permalink: string;
  deleteToken: string;
}

interface ShareResult {
  id: string;
  publicUrl: string;
  privateUrl: string;
  key: string;
  deleteToken: string;
}

interface StoredShareRecord {
  sessionKey: string;
  sessionHash: string;
  share: ShareResult;
  createdAt: string;
  deletedAt?: string;
}

interface ShareStore {
  version: 2;
  records: StoredShareRecord[];
}

interface ShareUpsertEvent {
  version: 2;
  type: "share.upsert";
  sessionKey: string;
  sessionHash: string;
  share: ShareResult;
  createdAt: string;
}

interface ShareDeleteEvent {
  version: 2;
  type: "share.delete";
  shareId: string;
  deletedAt: string;
}

type ShareStoreEvent = ShareUpsertEvent | ShareDeleteEvent;

const shareStoreLegacyPath = join(opentracesDir, "shares.json");
const shareStorePath = join(opentracesDir, "shares.jsonl");

function getAgentName(source: Session["source"]): string {
  if (source === "claude") return "Claude Code";
  if (source === "codex") return "Codex";
  if (source === "opencode") return "OpenCode";
  return "Pi Coding Agent";
}

function getSessionKey(session: Session): string {
  return `${session.source}:${session.path}`;
}

function hashSessionRaw(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function isValidShareResult(value: any): value is ShareResult {
  return Boolean(
    value &&
    typeof value.id === "string" &&
    typeof value.publicUrl === "string" &&
    typeof value.privateUrl === "string" &&
    typeof value.key === "string" &&
    typeof value.deleteToken === "string"
  );
}

function getEmptyShareStore(): ShareStore {
  return { version: 2, records: [] };
}

function isValidStoredShareRecord(record: any): record is StoredShareRecord {
  return Boolean(
    record &&
    typeof record.sessionKey === "string" &&
    typeof record.sessionHash === "string" &&
    typeof record.createdAt === "string" &&
    isValidShareResult(record.share) &&
    (record.deletedAt === undefined || typeof record.deletedAt === "string")
  );
}

function isShareStoreEvent(event: any): event is ShareStoreEvent {
  if (!event || typeof event !== "object") return false;
  if (event.version !== 2) return false;

  if (event.type === "share.upsert") {
    return typeof event.sessionKey === "string" &&
      typeof event.sessionHash === "string" &&
      typeof event.createdAt === "string" &&
      isValidShareResult(event.share);
  }

  if (event.type === "share.delete") {
    return typeof event.shareId === "string" && typeof event.deletedAt === "string";
  }

  return false;
}

function applyShareStoreEvent(store: ShareStore, event: ShareStoreEvent): void {
  if (event.type === "share.upsert") {
    upsertShareRecord(store, {
      sessionKey: event.sessionKey,
      sessionHash: event.sessionHash,
      share: event.share,
      createdAt: event.createdAt,
    });
    return;
  }

  markDeletedShareRecords(store, event.shareId, event.deletedAt);
}

async function appendShareStoreEvent(event: ShareStoreEvent): Promise<void> {
  await mkdir(opentracesDir, { recursive: true });
  await appendFile(shareStorePath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

async function migrateLegacyShareStore(store: ShareStore): Promise<void> {
  await mkdir(opentracesDir, { recursive: true });
  const events: ShareStoreEvent[] = [];

  for (const record of store.records) {
    events.push({
      version: 2,
      type: "share.upsert",
      sessionKey: record.sessionKey,
      sessionHash: record.sessionHash,
      share: record.share,
      createdAt: record.createdAt,
    });

    if (record.deletedAt) {
      events.push({
        version: 2,
        type: "share.delete",
        shareId: record.share.id,
        deletedAt: record.deletedAt,
      });
    }
  }

  const serialized = events.map((event) => JSON.stringify(event)).join("\n");
  await writeFile(shareStorePath, serialized ? `${serialized}\n` : "", { mode: 0o600 });
}

async function loadLegacyShareStore(): Promise<ShareStore> {
  try {
    const raw = await readFile(shareStoreLegacyPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ShareStore>;
    if (!parsed || !Array.isArray(parsed.records)) return getEmptyShareStore();

    const records = parsed.records.filter((record: any) => isValidStoredShareRecord(record)) as StoredShareRecord[];

    return {
      version: 2,
      records,
    };
  } catch {
    return getEmptyShareStore();
  }
}

async function loadShareStore(): Promise<ShareStore> {
  if (existsSync(shareStorePath)) {
    const store = getEmptyShareStore();
    const raw = await readFile(shareStorePath, "utf-8");

    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (!isShareStoreEvent(event)) continue;
        applyShareStoreEvent(store, event);
      } catch {}
    }

    return store;
  }

  const legacyStore = await loadLegacyShareStore();
  if (legacyStore.records.length > 0) {
    await migrateLegacyShareStore(legacyStore);
  }

  return legacyStore;
}

function getActiveShareBySessionKey(store: ShareStore, sessionKey: string): StoredShareRecord | undefined {
  for (let i = store.records.length - 1; i >= 0; i--) {
    const record = store.records[i];
    if (!record) continue;
    if (!record.deletedAt && record.sessionKey === sessionKey) return record;
  }
  return undefined;
}

function getActiveShareByHash(store: ShareStore, sessionHash: string): StoredShareRecord | undefined {
  for (let i = store.records.length - 1; i >= 0; i--) {
    const record = store.records[i];
    if (!record) continue;
    if (!record.deletedAt && record.sessionHash === sessionHash) return record;
  }
  return undefined;
}

function upsertShareRecord(store: ShareStore, entry: StoredShareRecord): void {
  const existingIndex = store.records.findIndex((record) => record.sessionKey === entry.sessionKey && !record.deletedAt);
  if (existingIndex >= 0) {
    store.records[existingIndex] = entry;
    return;
  }

  store.records.push(entry);
}

function markDeletedShareRecords(store: ShareStore, shareId: string, deletedAt = new Date().toISOString()): void {
  for (const record of store.records) {
    if (record.share.id === shareId && !record.deletedAt) record.deletedAt = deletedAt;
  }
}

async function uploadEncryptedSession(packed: Buffer, metadata: PublicShareMetadata, sessionHash: string): Promise<UploadSessionResponse> {
  if (packed.byteLength > MAX_SHARED_SESSION_BYTES) {
    throw new Error("session exceeds 200MB limit after encryption");
  }

  const response = await fetch(`${getPublicBaseUrl()}/api/sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-opentraces-meta": Buffer.from(JSON.stringify(metadata), "utf-8").toString("base64url"),
      "x-opentraces-content-sha256": sessionHash,
    },
    body: packed,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(errorBody || `session upload failed: ${response.status}`);
  }

  const body = await response.json() as Partial<UploadSessionResponse>;
  if (!body.id || !body.permalink || !body.deleteToken) {
    throw new Error("invalid upload response");
  }

  return {
    id: body.id,
    permalink: body.permalink,
    deleteToken: body.deleteToken,
  };
}

async function deleteSharedSession(share: ShareResult): Promise<void> {
  const response = await fetch(`${getPublicBaseUrl()}/api/sessions/${share.id}`, {
    method: "DELETE",
    headers: {
      "x-opentraces-delete-token": share.deleteToken,
    },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(errorBody || `session delete failed: ${response.status}`);
  }
}

// ── Share (encrypted permalink) ──────────────────────────────────────

const shareCache = new Map<string, ShareResult>();

async function getSessionRaw(session: Session): Promise<string> {
  if (session.source === "opencode") {
    // Export opencode session as JSON for sharing
    const conv = await parseOpencodeConversation(session.path);
    return JSON.stringify(conv);
  }
  if (session.source === "pi") {
    const conv = await parsePiConversation(session.path);
    return JSON.stringify(conv);
  }
  return await readFile(session.path, "utf-8");
}

function getSharedSessionModelId(session: Session, raw: string): string {
  if (session.source === "opencode" || session.source === "pi") {
    try {
      const parsed = JSON.parse(raw) as Conversation;
      return firstString(parsed.modelId);
    } catch {
      return "";
    }
  }

  let currentModelId = "";
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      const found = readModelId(parsed);
      if (found) currentModelId = found;
    } catch {}
  }

  return currentModelId;
}

function getSessionGithubUsername(viewerConfig: ViewerConfig): string {
  const configured = firstString(viewerConfig.githubUsername);
  if (configured) return configured.replace(/^@/, "");
  const envValue = firstString(process.env.GITHUB_USERNAME, process.env.GITHUB_USER, process.env.GH_USER);
  return envValue ? envValue.replace(/^@/, "") : "";
}

async function generateShareUrl(session: Session, raw: string, sessionHash: string, viewerConfig: ViewerConfig): Promise<ShareResult> {
  const compressed = deflateRawSync(Buffer.from(raw), { level: 9 });
  const modelId = getSharedSessionModelId(session, raw);
  const githubUsername = getSessionGithubUsername(viewerConfig);

  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const packed = Buffer.concat([iv, encrypted, authTag]);

  const uploaded = await uploadEncryptedSession(packed, {
    title: session.title.trim() || "(untitled)",
    agent: getAgentName(session.source),
    messageCount: session.messageCount,
    modelName: modelId || undefined,
    modelId: modelId || undefined,
    githubUsername: githubUsername || undefined,
  }, sessionHash);

  const keyB64 = key.toString("base64url");
  const base = `${getPublicBaseUrl()}/s/${uploaded.id}`;

  return {
    id: uploaded.id,
    publicUrl: base,
    privateUrl: `${base}#${keyB64}`,
    key: keyB64,
    deleteToken: uploaded.deleteToken,
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
  write(`${ansi.bold}${ansi.fg(255)} opentraces${ansi.reset}`);
  write(`${ansi.dim}${ansi.fg(240)}  ${state.filtered.length} sessions${ansi.reset}`);

  // Column headers
  write(ansi.moveTo(2, 1));
  const shW = 2;
  const srcW = 9;
  const projW = 14;
  const idW = 10;
  const msgW = 6;
  const dateW = 11;
  const titleW = Math.max(20, cols - shW - srcW - projW - idW - msgW - dateW - 8);
  write(
    `${ansi.dim}${ansi.fg(242)}` +
    `${fit("S", shW)} ${fit("SOURCE", srcW)} ${fit("PROJECT", projW)} ${fit("TITLE", titleW)} ${fit("ID", idW)} ${fit("MSGS", msgW)} ${fit("DATE", dateW)}` +
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
    const sessionKey = getSessionKey(session);
    const isShared = shareCache.has(sessionKey);

    const srcColor = session.source === "claude"
      ? ansi.fg(141)
      : session.source === "opencode"
        ? ansi.fg(214)
        : session.source === "pi"
          ? ansi.fg(81)
          : ansi.fg(71);
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
      `${selected ? "" : isShared ? ansi.fg(114) : ansi.fg(239)}${fit(isShared ? "●" : "", shW)}${selected ? "" : ansi.reset}` +
      `${selected ? "" : ansi.fg(245)} ` +
      `${selected ? "" : srcColor}${fit(session.source, srcW)}${selected ? "" : ansi.reset}` +
      `${selected ? "" : ansi.fg(245)} ` +
      `${fit(project, projW)} ` +
      `${selected ? "" : isShared ? `${ansi.bold}${ansi.fg(114)}` : ansi.fg(250)}${fit(session.title, titleW)}${selected ? "" : isShared ? ansi.reset + ansi.fg(245) : ""} ` +
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
      `↑↓ navigate  / search  s share  c copy public  d delete share  o open  q quit` +
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
    const commands: Array<[string, string[]]> = process.platform === "win32"
      ? [["clip", []]]
      : process.platform === "darwin"
        ? [["pbcopy", []]]
        : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]];

    for (const [command, args] of commands) {
      try {
        await runCommand(command, args, text);
        return true;
      } catch {}
    }

    return false;
  } catch {
    return false;
  }
}

async function openInBrowser(path: string) {
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "cmd"
      : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", path] : [path];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.unref();
}

async function runTui() {
  write(ansi.altScreen);
  write(ansi.hideCursor);

  const shareStore = await loadShareStore();
  const viewerConfig = await loadViewerConfig();
  for (const record of shareStore.records) {
    if (!record.deletedAt) shareCache.set(record.sessionKey, record.share);
  }

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
    streamPiSessions(onSession),
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
      const session = state.filtered[state.cursor];
      if (!session) return;
      const sessionKey = getSessionKey(session);
      const cached = shareCache.get(sessionKey);
      if (cached) {
        const ok = await copyToClipboard(cached.privateUrl);
        setStatus(state, ok ? `copied! key: ${cached.key}` : "clipboard failed", 8000);
        state.lastShare = cached;
      } else {
        setStatus(state, "encrypting & uploading...");
        try {
          const raw = await getSessionRaw(session);
          const sessionHash = hashSessionRaw(raw);
          const existingShared = getActiveShareByHash(shareStore, sessionHash);

          if (existingShared) {
            const reused: StoredShareRecord = {
              sessionKey,
              sessionHash,
              share: existingShared.share,
              createdAt: new Date().toISOString(),
            };
            upsertShareRecord(shareStore, reused);
            await appendShareStoreEvent({
              version: 2,
              type: "share.upsert",
              sessionKey: reused.sessionKey,
              sessionHash: reused.sessionHash,
              share: reused.share,
              createdAt: reused.createdAt,
            });
            shareCache.set(sessionKey, existingShared.share);
            state.lastShare = existingShared.share;
            const ok = await copyToClipboard(existingShared.share.privateUrl);
            setStatus(state, ok ? `already shared. copied key: ${existingShared.share.key}` : "clipboard failed", 8000);
            render(state);
            return;
          }

          const share = await generateShareUrl(session, raw, sessionHash, viewerConfig);
          shareCache.set(sessionKey, share);
          upsertShareRecord(shareStore, {
            sessionKey,
            sessionHash,
            share,
            createdAt: new Date().toISOString(),
          });
          await appendShareStoreEvent({
            version: 2,
            type: "share.upsert",
            sessionKey,
            sessionHash,
            share,
            createdAt: new Date().toISOString(),
          });
          state.lastShare = share;
          const ok = await copyToClipboard(share.privateUrl);
          setStatus(state, ok ? `copied! key: ${share.key}` : "clipboard failed", 8000);
          render(state);
        } catch (e: any) {
          setStatus(state, `error: ${e.message}`);
        }
      }
    } else if (key === "c") {
      const session = state.filtered[state.cursor];
      const fromSelection = session ? shareCache.get(getSessionKey(session)) : undefined;
      const share = fromSelection ?? state.lastShare;

      if (!share) {
        setStatus(state, "press s first to share");
      } else {
        const ok = await copyToClipboard(share.publicUrl);
        setStatus(state, ok ? "public url copied (no key)" : "clipboard failed");
      }
    } else if (key === "d") {
      const session = state.filtered[state.cursor];
      if (!session) return;

      const sessionKey = getSessionKey(session);

      const share = shareCache.get(sessionKey);
      if (!share) {
        setStatus(state, "session not shared yet");
        return;
      }

      setStatus(state, "deleting shared session...");
      try {
        await deleteSharedSession(share);
        for (const [key, value] of shareCache.entries()) {
          if (value.id === share.id) shareCache.delete(key);
        }
        const deletedAt = new Date().toISOString();
        markDeletedShareRecords(shareStore, share.id, deletedAt);
        await appendShareStoreEvent({
          version: 2,
          type: "share.delete",
          shareId: share.id,
          deletedAt,
        });
        if (state.lastShare?.id === share.id) state.lastShare = undefined;
        setStatus(state, "shared session deleted");
        render(state);
      } catch (e: any) {
        setStatus(state, `error: ${e.message}`);
      }
    } else if (key === "o") {
      // Open in browser
      const session = state.filtered[state.cursor];
      if (!session) return;
      setStatus(state, "opening...");
      try {
        const conv = await parseSession(session);
        const html = generateHtml(conv, viewerConfig);
        const tmp = join(
          tmpdir(),
          `opentraces-${session.id.slice(0, 8)}.html`
        );
        await writeFile(tmp, html);
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
        const html = generateHtml(conv, viewerConfig);
        const outPath = `${session.id.slice(0, 8)}.html`;
        await writeFile(outPath, html);
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
