#!/usr/bin/env node
// Build an overlay of this branch onto a published Paperclip release, for the Collexa box (.71).
//
//   node scripts/collexa/build-overlay.mjs <base-version> [out-dir]
//
// The branch must be <base release tag> + our commits. The script builds the packages those commits
// touch, downloads the pristine release packages from npm, and keeps only the compiled files that
// differ. Every overlaid file that exists in the release is pinned by sha256, so the installer refuses
// any other base. The UI bundle (server/ui-dist) is rebuilt and replaced whole: its hashed file names
// change with any source change. The runner binary is never shipped: the release's stays in place.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const base = process.argv[2];
if (!base || !/^\d{4}\.\d{3,4}\.\d+$/.test(base)) {
  console.error("usage: build-overlay.mjs <base-version, e.g. 2026.1023.0> [out-dir]");
  process.exit(2);
}
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const outDir = path.resolve(process.argv[3] ?? path.join(root, "dist-overlay"));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

if (git("status", "--porcelain", "--untracked-files=no")) {
  console.error("refusing: the working tree has uncommitted changes");
  process.exit(1);
}
try {
  git("merge-base", "--is-ancestor", `v${base}`, "HEAD");
} catch {
  console.error(`refusing: HEAD is not based on the release tag v${base}`);
  process.exit(1);
}
const sha = git("rev-parse", "HEAD");
const ref = git("rev-parse", "--abbrev-ref", "HEAD");
const commits = git("log", "--format=%h %s", `v${base}..HEAD`).split("\n").filter(Boolean);

// Package name -> workspace dir. Only these are compared; extend when a change touches another package.
const packages = {
  "@paperclipai/server": "server",
  "@paperclipai/adapter-utils": "packages/adapter-utils",
  "@paperclipai/hermes-paperclip-adapter": "packages/adapters/hermes",
};

console.log(`building ${ref} @ ${sha.slice(0, 9)} over ${base}`);
run("pnpm", ["--filter", "@paperclipai/shared", "--filter", "@paperclipai/db", "--filter", "@paperclipai/adapter-utils",
  "--filter", "@paperclipai/hermes-paperclip-adapter", "build"]);
run("pnpm", ["exec", "tsc"], path.join(root, "server"));
run("pnpm", ["--filter", "@paperclipai/ui", "build"]);

const work = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-overlay-"));
const release = (name) => {
  const dir = path.join(work, "release", name.replace("/", "__"));
  fs.mkdirSync(dir, { recursive: true });
  const tgz = execFileSync("npm", ["pack", `${name}@${base}`, "--silent", "--pack-destination", dir], { encoding: "utf8" }).trim().split("\n").pop();
  execFileSync("tar", ["-xzf", path.join(dir, tgz), "-C", dir]);
  return path.join(dir, "package");
};
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const walk = (dir, rel = "") => fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((entry) => {
  const child = path.join(rel, entry.name);
  return entry.isDirectory() ? walk(dir, child) : [child];
});
const shipped = (rel) => rel.endsWith(".js") && !rel.endsWith(".test.js") && !rel.split(path.sep).includes("vendor");

const stage = path.join(work, "payload");
const files = [];
for (const [name, dir] of Object.entries(packages)) {
  const ours = path.join(root, dir, "dist");
  const theirs = path.join(release(name), "dist");
  for (const rel of walk(ours).filter(shipped)) {
    const releaseFile = path.join(theirs, rel);
    const exists = fs.existsSync(releaseFile);
    const ourHash = sha256(path.join(ours, rel));
    if (exists && sha256(releaseFile) === ourHash) continue;
    const target = path.join("node_modules", name, "dist", rel);
    fs.mkdirSync(path.dirname(path.join(stage, target)), { recursive: true });
    fs.copyFileSync(path.join(ours, rel), path.join(stage, target));
    files.push({ path: target, sha256: ourHash, baseSha256: exists ? sha256(releaseFile) : null });
  }
}
const uiTarget = path.join("node_modules", "@paperclipai/server", "ui-dist");
fs.cpSync(path.join(root, "ui", "dist"), path.join(stage, uiTarget), { recursive: true });

if (files.length === 0) throw new Error("no compiled file differs from the release; nothing to ship");
if (files.length > 60) throw new Error(`${files.length} files differ from the release; is the branch really based on v${base}?`);

const id = `${base}-${ref.replace(/[^A-Za-z0-9._-]/g, "-")}-${sha.slice(0, 9)}`;
const manifest = {
  schema: "collexa.paperclip-overlay/v1",
  id,
  baseVersion: base,
  repo: "https://github.com/Z33DD/paperclip",
  ref,
  sha,
  builtAt: new Date().toISOString(),
  commits,
  files,
  replaceDirs: [uiTarget],
};
fs.writeFileSync(path.join(stage, "overlay.json"), `${JSON.stringify(manifest, null, 2)}\n`);
fs.mkdirSync(outDir, { recursive: true });
const tarball = path.join(outDir, `paperclip-overlay-${id}.tar.gz`);
execFileSync("tar", ["-czf", tarball, "-C", stage, "."]);
fs.rmSync(work, { recursive: true, force: true });

console.log(`\n${tarball}`);
console.log(`${files.length} compiled files (${files.filter((f) => !f.baseSha256).length} new) + ui-dist`);
for (const f of files) console.log(`  ${f.baseSha256 ? "M" : "A"} ${f.path}`);
