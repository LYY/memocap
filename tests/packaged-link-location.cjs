"use strict";

const { fileURLToPath } = require("node:url");

function linkLocation(location, roots) {
  if (typeof location !== "string") return null;
  const frame = /^(.*?)(file:\/\/.+)(:\d+:\d+\)?)$/.exec(location);
  if (frame) return `${frame[1]}${linkLocation(frame[2], roots)}${frame[3]}`;
  let normalized = location;
  if (location.startsWith("file://")) {
    try {
      normalized = fileURLToPath(location, { windows: roots.some(root => /^[A-Za-z]:\//.test(root)) });
    } catch (error) {
      if (error instanceof TypeError || error instanceof URIError) return location;
      throw error;
    }
  }
  normalized = normalized.replaceAll("\\", "/");
  for (const root of roots) {
    if (normalized === root || normalized.startsWith(`${root}/`)) return `<sandbox>${normalized.slice(root.length)}`;
  }
  return normalized;
}

module.exports = { linkLocation };
