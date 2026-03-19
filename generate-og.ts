#!/usr/bin/env bun
// Generate OG image by screenshotting the landing page at 1200x630
import { writeFileSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import puppeteer from "puppeteer";

const dir = import.meta.dir;
mkdirSync(join(dir, "site"), { recursive: true });

const htmlPath = join(dir, "site", "index.html");
const outPath = join(dir, "site", "og.png");

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 2 });
await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle0" });
await page.screenshot({ path: outPath, type: "png" });
await browser.close();

console.log("generated site/og.png");
