#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { DEFAULT_PUBLIC_BASE_URL, getPublicBaseUrl, getPublicHost, normalizePublicBaseUrl } from "./public-url.js";

const rootDir = dirname(fileURLToPath(import.meta.url));
const siteDir = join(rootDir, "site");
const indexHtml = await readFile(join(siteDir, "index.html"), "utf-8");
const buildBaseUrl = getPublicBaseUrl();
const buildHost = getPublicHost(buildBaseUrl);

function renderHtml(origin) {
  const runtimeBaseUrl = normalizePublicBaseUrl(process.env.OPENTRACES_PUBLIC_URL ?? origin, origin);
  const runtimeHost = getPublicHost(runtimeBaseUrl);

  return indexHtml
    .replaceAll("{{PUBLIC_URL}}", runtimeBaseUrl)
    .replaceAll("{{PUBLIC_HOST}}", runtimeHost)
    .replaceAll(buildBaseUrl, runtimeBaseUrl)
    .replaceAll(buildHost, runtimeHost)
    .replaceAll(DEFAULT_PUBLIC_BASE_URL, runtimeBaseUrl)
    .replaceAll("https://opentraces.pages.dev", runtimeBaseUrl)
    .replaceAll("opentraces.pages.dev", runtimeHost);
}

const app = new Hono();

if (existsSync(join(siteDir, "og.png"))) {
  app.get("/og.png", serveStatic({ path: join(siteDir, "og.png") }));
}

app.get("*", (c) => c.html(renderHtml(new URL(c.req.url).origin)));

const port = Number(process.env.PORT ?? 3000);

serve({
  fetch: app.fetch,
  port,
});

console.log(`opentraces server listening on http://localhost:${port}`);
