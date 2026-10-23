import fs from "node:fs";
import path from "node:path";
import launcher from "../../bin/cli.cjs";

export function inspectCache(runtime, version) {
  if (!version) return { status: "missing", binary: null };
  const home = runtime.env.HOME || runtime.env.USERPROFILE;
  const base = runtime.platform === "darwin" ? path.join(home, "Library/Caches")
    : runtime.platform === "win32" ? runtime.env.LOCALAPPDATA || path.join(home, "AppData/Local") : runtime.env.XDG_CACHE_HOME || path.join(home, ".cache");
  const name = launcher.resolveReleaseAsset(runtime.platform, runtime.arch).name;
  const binary = path.join(base, "memocap", version, name);
  if (!fs.existsSync(binary)) return { status: "missing", binary };
  return { status: launcher.verifyCachedBinary(binary, `${binary}.sha256`, name) ? "verified" : "invalid", binary };
}
