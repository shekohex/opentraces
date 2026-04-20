#!/usr/bin/env node
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDir = join(rootDir, "public", "assets", "fonts");
const tempDir = mkdtempSync(join(tmpdir(), "opentraces-font-"));

function run(command, args, cwd = rootDir) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
}

try {
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });

  run("gh", [
    "release",
    "download",
    "--repo",
    "ryanoasis/nerd-fonts",
    "--pattern",
    "IBMPlexMono.zip",
    "--dir",
    tempDir,
  ]);

  run("unzip", [
    "-o",
    "-j",
    join(tempDir, "IBMPlexMono.zip"),
    "BlexMonoNerdFontMono-Regular.ttf",
    "BlexMonoNerdFontMono-Bold.ttf",
    "-d",
    outputDir,
  ]);

  renameSync(
    join(outputDir, "BlexMonoNerdFontMono-Regular.ttf"),
    join(outputDir, "IBMPlexNerdFontMono-Regular.ttf"),
  );
  renameSync(
    join(outputDir, "BlexMonoNerdFontMono-Bold.ttf"),
    join(outputDir, "IBMPlexNerdFontMono-Bold.ttf"),
  );

  console.log(`vendored fonts into ${outputDir}`);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
