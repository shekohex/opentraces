#!/usr/bin/env node
import { existsSync, mkdirSync } from "node:fs";
import { readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { cors } from "hono/cors";
import { cache } from "hono/cache";
import { compress } from "hono/compress";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { DEFAULT_PUBLIC_BASE_URL, getPublicBaseUrl, getPublicHost, normalizePublicBaseUrl } from "./public-url.js";

const rootDir = dirname(fileURLToPath(import.meta.url));
const siteDir = join(rootDir, "site");
const indexHtml = await readFile(join(siteDir, "index.html"), "utf-8");
const buildBaseUrl = getPublicBaseUrl();
const buildHost = getPublicHost(buildBaseUrl);
const MAX_SESSION_BYTES = 200 * 1024 * 1024;
const storageDir = process.env.OPENTRACES_STORAGE_DIR || join(rootDir, ".opentraces-store");
const storageBlobDir = join(storageDir, "blobs");
const storageMetaDir = join(storageDir, "meta");
const viewerConfigPath = join(homedir(), ".opentraces", "config.json");

mkdirSync(storageBlobDir, { recursive: true });
mkdirSync(storageMetaDir, { recursive: true });

function getDefaultViewerConfig() {
  return {
    userLabel: "user",
    userAvatarUrl: "",
    assistantFallbackLabel: "assistant",
    githubUsername: "",
  };
}

function normalizeViewerConfig(config) {
  const defaults = getDefaultViewerConfig();
  if (!config || typeof config !== "object") return defaults;

  return {
    userLabel: typeof config.userLabel === "string" && config.userLabel.trim() ? config.userLabel.trim().slice(0, 80) : defaults.userLabel,
    userAvatarUrl: typeof config.userAvatarUrl === "string" ? config.userAvatarUrl.trim().slice(0, 500) : defaults.userAvatarUrl,
    assistantFallbackLabel: typeof config.assistantFallbackLabel === "string" && config.assistantFallbackLabel.trim()
      ? config.assistantFallbackLabel.trim().slice(0, 80)
      : defaults.assistantFallbackLabel,
    githubUsername: typeof config.githubUsername === "string" ? config.githubUsername.trim().replace(/^@/, "").slice(0, 80) : defaults.githubUsername,
  };
}

async function loadViewerConfig() {
  try {
    const raw = await readFile(viewerConfigPath, "utf-8");
    return normalizeViewerConfig(JSON.parse(raw));
  } catch {
    return getDefaultViewerConfig();
  }
}

const viewerConfig = await loadViewerConfig();

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizePublicMetadata(metadata) {
  if (!metadata) return null;
  return {
    id: metadata.id,
    title: metadata.title,
    agent: metadata.agent,
    modelName: metadata.modelName,
    modelId: metadata.modelId,
    githubUsername: metadata.githubUsername,
    githubAvatarUrl: metadata.githubAvatarUrl,
    messageCount: metadata.messageCount,
    createdAt: metadata.createdAt,
    sizeBytes: metadata.sizeBytes,
  };
}

function getPageMetadata(baseUrl, sessionId, metadata) {
  if (sessionId && metadata) {
    const title = `${metadata.title} — ${metadata.agent} | opentraces`;
    const modelLabel = metadata.modelName || metadata.modelId;
    const modelText = modelLabel ? ` Model: ${modelLabel}.` : "";
    const usernameText = metadata.githubUsername ? ` Author: @${metadata.githubUsername}.` : "";
    const description = `${metadata.agent} session with ${metadata.messageCount} messages.${modelText}${usernameText} End-to-end encrypted.`;
    return {
      title,
      description,
      url: `${baseUrl}/s/${sessionId}`,
      ogTitle: title,
      ogDescription: description,
    };
  }

  if (sessionId) {
    return {
      title: "Encrypted session | opentraces",
      description: "End-to-end encrypted AI coding session permalink.",
      url: `${baseUrl}/s/${sessionId}`,
      ogTitle: "Encrypted session | opentraces",
      ogDescription: "End-to-end encrypted AI coding session permalink.",
    };
  }

  return {
    title: "opentraces — browse, export & share AI coding sessions",
    description: "A terminal UI to browse, export, and share your Claude Code, Codex, OpenCode, and Pi Coding Agent sessions. End-to-end encrypted sharing via stable permalinks.",
    url: baseUrl,
    ogTitle: "opentraces",
    ogDescription: "Browse, export & share your Claude Code, Codex, OpenCode, and Pi Coding Agent sessions. Fuzzy search, encrypted sharing, vim keybindings.",
  };
}

function renderHtml(origin, options = {}) {
  const runtimeBaseUrl = normalizePublicBaseUrl(process.env.OPENTRACES_PUBLIC_URL ?? origin, origin);
  const runtimeHost = getPublicHost(runtimeBaseUrl);
  const sessionId = typeof options.sessionId === "string" ? options.sessionId : null;
  const publicMetadata = normalizePublicMetadata(options.metadata);
  const page = getPageMetadata(runtimeBaseUrl, sessionId, publicMetadata);

  return indexHtml
    .replaceAll("{{PUBLIC_URL}}", runtimeBaseUrl)
    .replaceAll("{{PUBLIC_HOST}}", runtimeHost)
    .replaceAll("{{PAGE_TITLE}}", escapeHtml(page.title))
    .replaceAll("{{PAGE_DESCRIPTION}}", escapeHtml(page.description))
    .replaceAll("{{PAGE_URL}}", escapeHtml(page.url))
    .replaceAll("{{OG_TITLE}}", escapeHtml(page.ogTitle))
    .replaceAll("{{OG_DESCRIPTION}}", escapeHtml(page.ogDescription))
    .replaceAll("{{SESSION_ID_JSON}}", JSON.stringify(sessionId))
    .replaceAll("{{SESSION_METADATA_JSON}}", JSON.stringify(publicMetadata || null))
    .replaceAll("{{VIEWER_CONFIG_JSON}}", JSON.stringify(viewerConfig))
    .replaceAll(buildBaseUrl, runtimeBaseUrl)
    .replaceAll(buildHost, runtimeHost)
    .replaceAll(DEFAULT_PUBLIC_BASE_URL, runtimeBaseUrl)
    .replaceAll("https://opentraces.pages.dev", runtimeBaseUrl)
    .replaceAll("opentraces.pages.dev", runtimeHost);
}

function isValidSessionId(sessionId) {
  return typeof sessionId === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(sessionId);
}

function getBlobPath(sessionId) {
  return join(storageBlobDir, `${sessionId}.bin`);
}

function getMetaPath(sessionId) {
  return join(storageMetaDir, `${sessionId}.json`);
}

async function readSessionMetadata(sessionId) {
  try {
    const raw = await readFile(getMetaPath(sessionId), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseUploadMetadata(headerValue) {
  if (!headerValue) return null;

  try {
    const decoded = Buffer.from(headerValue, "base64url").toString("utf-8");
    const parsed = JSON.parse(decoded);

    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.title !== "string") return null;
    if (typeof parsed.agent !== "string") return null;
    if (typeof parsed.messageCount !== "number") return null;

    const title = parsed.title.trim().slice(0, 200);
    const agent = parsed.agent.trim().slice(0, 80);
    const messageCount = Number.isFinite(parsed.messageCount)
      ? Math.max(0, Math.floor(parsed.messageCount))
      : 0;

    if (!title || !agent) return null;

    const modelId = typeof parsed.modelId === "string" ? parsed.modelId.trim().slice(0, 120) : "";
    const modelName = typeof parsed.modelName === "string" ? parsed.modelName.trim().slice(0, 120) : "";
    const githubUsername = typeof parsed.githubUsername === "string"
      ? parsed.githubUsername.trim().replace(/^@/, "").slice(0, 80)
      : "";

    return { title, agent, messageCount, modelId, modelName, githubUsername };
  } catch {
    return null;
  }
}

async function resolveGithubAvatarUrl(githubUsername) {
  const username = String(githubUsername || "").trim().replace(/^@/, "");
  if (!username) return "";

  const fallback = `https://github.com/${encodeURIComponent(username)}.png`;

  try {
    const response = await fetch(fallback, {
      method: "GET",
      redirect: "follow",
      headers: { "user-agent": "opentraces" },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return fallback;
    return response.url || fallback;
  } catch {
    return fallback;
  }
}

function parseContentHash(headerValue) {
  const value = String(headerValue || "").trim().toLowerCase();
  if (!value) return null;
  if (!/^[a-f0-9]{64}$/.test(value)) return null;
  return value;
}

function getDeleteTokenHashes(metadata) {
  if (Array.isArray(metadata?.deleteTokenHashes)) {
    return metadata.deleteTokenHashes
      .filter((v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v));
  }

  if (typeof metadata?.deleteTokenHash === "string" && /^[a-f0-9]{64}$/.test(metadata.deleteTokenHash)) {
    return [metadata.deleteTokenHash];
  }

  return [];
}

async function findSessionByContentHash(contentHash) {
  const files = await readdir(storageMetaDir);
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(storageMetaDir, file), "utf-8");
      const metadata = JSON.parse(raw);
      if (metadata?.contentHash === contentHash && existsSync(getBlobPath(metadata.id))) {
        return metadata;
      }
    } catch {}
  }
  return null;
}

async function generateSessionId() {
  for (let i = 0; i < 5; i++) {
    const id = randomBytes(9).toString("base64url");
    if (!existsSync(getMetaPath(id)) && !existsSync(getBlobPath(id))) {
      return id;
    }
  }

  throw new Error("failed to allocate session id");
}

function getRuntimeBaseUrl(requestUrl) {
  const origin = new URL(requestUrl).origin;
  return normalizePublicBaseUrl(process.env.OPENTRACES_PUBLIC_URL ?? origin, origin);
}

function getPreferredFormat(acceptHeader) {
  const accept = String(acceptHeader || "").toLowerCase();
  if (accept.includes("application/json")) return "json";
  return "html";
}

function buildSessionMetadataPayload(baseUrl, sessionId, metadata) {
  return {
    ...normalizePublicMetadata(metadata),
    permalink: `${baseUrl}/s/${sessionId}`,
  };
}

function renderMetadataHtml(metadataPayload) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(metadataPayload.title)} | opentraces metadata</title></head><body><pre>${escapeHtml(JSON.stringify(metadataPayload, null, 2))}</pre></body></html>`;
}

const app = new Hono();

app.use("*", requestId());
app.use("*", logger());
app.use("*", compress());
app.use("*", secureHeaders({
  contentSecurityPolicy: false,
  xFrameOptions: "DENY",
  xXssProtection: "1; mode=block",
}));
app.use("/api/*", cors());

app.use("/assets/fonts/*", async (c, next) => {
  await next();
  c.header("Cache-Control", "public, max-age=31536000, immutable");
});

if (typeof globalThis.caches !== "undefined") {
  app.use("/assets/*", cache({
    cacheName: "opentraces-assets",
    cacheControl: "public, max-age=31536000, immutable",
  }));

  app.use("/og.png", cache({
    cacheName: "opentraces-assets",
    cacheControl: "public, max-age=86400",
  }));
}

if (existsSync(join(siteDir, "og.png"))) {
  app.get("/og.png", serveStatic({ path: join(siteDir, "og.png") }));
}

app.get("/assets/*", serveStatic({ root: siteDir }));

app.post("/api/sessions", async (c) => {
  const contentLengthRaw = c.req.header("content-length");
  if (contentLengthRaw) {
    const contentLength = Number(contentLengthRaw);
    if (Number.isFinite(contentLength) && contentLength > MAX_SESSION_BYTES) {
      return c.text("session exceeds 200MB limit", 413);
    }
  }

  const metadata = parseUploadMetadata(c.req.header("x-opentraces-meta"));
  if (!metadata) {
    return c.text("invalid or missing x-opentraces-meta", 400);
  }

  const contentHash = parseContentHash(c.req.header("x-opentraces-content-sha256"));
  if (c.req.header("x-opentraces-content-sha256") && !contentHash) {
    return c.text("invalid x-opentraces-content-sha256", 400);
  }

  const payload = Buffer.from(await c.req.arrayBuffer());
  if (payload.byteLength === 0) {
    return c.text("empty payload", 400);
  }

  if (payload.byteLength > MAX_SESSION_BYTES) {
    return c.text("session exceeds 200MB limit", 413);
  }

  const runtimeBaseUrl = getRuntimeBaseUrl(c.req.url);
  const deleteToken = randomBytes(32).toString("base64url");
  const deleteTokenHash = createHash("sha256").update(deleteToken).digest("hex");
  const githubAvatarUrl = await resolveGithubAvatarUrl(metadata.githubUsername);

  if (contentHash) {
    const existing = await findSessionByContentHash(contentHash);
    if (existing) {
      const existingDeleteHashes = getDeleteTokenHashes(existing);
      if (!existingDeleteHashes.includes(deleteTokenHash)) {
        existingDeleteHashes.push(deleteTokenHash);
      }

      existing.deleteTokenHashes = existingDeleteHashes;
      if (!existing.modelId && metadata.modelId) existing.modelId = metadata.modelId;
      if (!existing.modelName && metadata.modelName) existing.modelName = metadata.modelName;
      if (!existing.githubUsername && metadata.githubUsername) existing.githubUsername = metadata.githubUsername;
      if (!existing.githubAvatarUrl && githubAvatarUrl) existing.githubAvatarUrl = githubAvatarUrl;
      delete existing.deleteTokenHash;
      await writeFile(getMetaPath(existing.id), JSON.stringify(existing));

      return c.json({
        id: existing.id,
        permalink: `${runtimeBaseUrl}/s/${existing.id}`,
        deleteToken,
        deduplicated: true,
      });
    }
  }

  const sessionId = await generateSessionId();
  const createdAt = new Date().toISOString();

  const sessionMetadata = {
    id: sessionId,
    title: metadata.title,
    agent: metadata.agent,
    modelName: metadata.modelName || metadata.modelId || "",
    modelId: metadata.modelId || "",
    githubUsername: metadata.githubUsername || "",
    githubAvatarUrl,
    messageCount: metadata.messageCount,
    sizeBytes: payload.byteLength,
    createdAt,
    contentHash,
    deleteTokenHashes: [deleteTokenHash],
  };

  await writeFile(getBlobPath(sessionId), payload);
  await writeFile(getMetaPath(sessionId), JSON.stringify(sessionMetadata));

  return c.json({
    id: sessionId,
    permalink: `${runtimeBaseUrl}/s/${sessionId}`,
    deleteToken,
  });
});

app.get("/api/sessions/:id/meta", async (c) => {
  const id = c.req.param("id");
  if (!isValidSessionId(id)) {
    return c.text("invalid session id", 400);
  }

  const metadata = await readSessionMetadata(id);
  if (!metadata) {
    return c.text("session not found", 404);
  }

  return c.json(normalizePublicMetadata(metadata), 200, {
    "cache-control": "no-store",
  });
});

app.get("/api/sessions/:id/blob", async (c) => {
  const id = c.req.param("id");
  if (!isValidSessionId(id)) {
    return c.text("invalid session id", 400);
  }

  try {
    const payload = await readFile(getBlobPath(id));
    return c.body(payload, 200, {
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
    });
  } catch {
    return c.text("session not found", 404);
  }
});

app.delete("/api/sessions/:id", async (c) => {
  const id = c.req.param("id");
  if (!isValidSessionId(id)) {
    return c.text("invalid session id", 400);
  }

  const metadata = await readSessionMetadata(id);
  if (!metadata) {
    return c.text("session not found", 404);
  }

  const token = c.req.header("x-opentraces-delete-token");
  if (!token) {
    return c.text("missing delete token", 401);
  }

  const tokenHashes = getDeleteTokenHashes(metadata);
  if (tokenHashes.length === 0) {
    return c.text("delete token unavailable", 403);
  }

  const providedHash = createHash("sha256").update(token).digest();
  const hashMatched = tokenHashes.some((hash) => {
    const expected = Buffer.from(hash, "hex");
    return expected.length === providedHash.length && timingSafeEqual(expected, providedHash);
  });

  if (!hashMatched) {
    return c.text("invalid delete token", 403);
  }

  await Promise.allSettled([
    unlink(getBlobPath(id)),
    unlink(getMetaPath(id)),
  ]);

  return c.json({ ok: true });
});

app.get("/s/:id", async (c) => {
  const format = getPreferredFormat(c.req.header("accept"));
  const metadataOnly = c.req.query("metadata") === "1";
  const sessionId = c.req.param("id");
  const runtimeBaseUrl = getRuntimeBaseUrl(c.req.url);

  if (!isValidSessionId(sessionId)) {
    if (format === "json") return c.json({ error: "invalid session id" }, 400, { "cache-control": "no-store", Vary: "Accept" });
    return c.html(renderHtml(new URL(c.req.url).origin), 200, { "cache-control": "no-store", Vary: "Accept" });
  }

  const metadata = await readSessionMetadata(sessionId);
  if (!metadata) {
    if (format === "json") return c.json({ error: "session not found" }, 404, { "cache-control": "no-store", Vary: "Accept" });
    return c.html(renderHtml(new URL(c.req.url).origin, { sessionId }), 404, { "cache-control": "no-store", Vary: "Accept" });
  }

  const metadataPayload = buildSessionMetadataPayload(runtimeBaseUrl, sessionId, metadata);

  if (format === "json") {
    if (metadataOnly) {
      return c.json(metadataPayload, 200, { "cache-control": "no-store", Vary: "Accept" });
    }

    const encryptedPayload = await readFile(getBlobPath(sessionId));
    const encryptedPayloadBase64 = encryptedPayload.toString("base64");

    return c.json({
      ...metadataPayload,
      encryptedPayloadBase64,
      e2ee: true,
      keyInUrlFragment: true,
    }, 200, { "cache-control": "no-store", Vary: "Accept" });
  }

  if (metadataOnly) {
    return c.html(renderMetadataHtml(metadataPayload), 200, { "cache-control": "no-store", Vary: "Accept" });
  }

  return c.html(renderHtml(new URL(c.req.url).origin, { sessionId, metadata }), 200, { "cache-control": "no-store", Vary: "Accept" });
});

app.get("*", (c) => c.html(renderHtml(new URL(c.req.url).origin)));

const port = Number(process.env.PORT ?? 3000);

serve({
  fetch: app.fetch,
  port,
});

console.log(`opentraces server listening on http://localhost:${port}`);
