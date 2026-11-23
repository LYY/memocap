const number = '(?:0|[1-9][0-9]*)';
const prerelease = `(?:${number}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
const build = '[0-9A-Za-z-]+';
const v1 = new RegExp(String.raw`^1\.${number}\.${number}(?:-${prerelease}(?:\.${prerelease})*)?(?:\+${build}(?:\.${build})*)?$`);

export function isSupportedHost(version) {
  return typeof version === 'string' && v1.test(version);
}
