// Builds the kata engine and stages it as a Tauri sidecar binary named
// kata-<target-triple>[.exe] under src-tauri/binaries/. Pass --release to
// build/stage the release profile (used by tauri:build); default is debug.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const profile = process.argv.includes("--release") ? "release" : "debug";
const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(appDir, "..");

// Host target triple from rustc -vV (the line `host: <triple>`).
const vv = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
const triple = vv.split("\n").find((l) => l.startsWith("host:")).slice(5).trim();
const ext = process.platform === "win32" ? ".exe" : "";

// Build the engine.
const buildArgs = ["build", "-p", "kata-cli"];
if (profile === "release") buildArgs.push("--release");
execFileSync("cargo", buildArgs, { cwd: repoRoot, stdio: "inherit" });

// Copy target/<profile>/kata -> src-tauri/binaries/kata-<triple>.
const src = join(repoRoot, "target", profile, `kata${ext}`);
const destDir = join(appDir, "src-tauri", "binaries");
mkdirSync(destDir, { recursive: true });
const dest = join(destDir, `kata-${triple}${ext}`);
copyFileSync(src, dest);
console.log(`staged sidecar: ${dest}`);
