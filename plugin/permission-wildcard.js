export function matchesPermissionWildcard(value, pattern) {
  const escaped = pattern.replaceAll("\\", "/").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  const expression = escaped.endsWith(" .*") ? `${escaped.slice(0, -3)}( .*)?` : escaped;
  return new RegExp(`^${expression}$`, process.platform === "win32" ? "si" : "s").test(value.replaceAll("\\", "/"));
}
