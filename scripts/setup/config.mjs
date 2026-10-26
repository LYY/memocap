import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyEdits, createScanner, findNodeAtLocation, modify, parse, parseTree, SyntaxKind } from "jsonc-parser";
import { packageName, SetupError } from "./arguments.mjs";
import { ancestors, atomicWrite, digest, readText } from "./files.mjs";

export function parseConfig(filename, text = readText(filename)) {
  const errors = [];
  const config = parse(text ?? "{}", errors, { allowTrailingComma: true });
  if (errors.length || !config || typeof config !== "object" || Array.isArray(config)) throw new SetupError("invalid_config", `Invalid JSONC object: ${filename}`, errors);
  if (config.plugin !== undefined && (!Array.isArray(config.plugin) || config.plugin.some((entry) => typeof pluginSource(entry) !== "string"))) {
    throw new SetupError("invalid_plugin_config", `Invalid plugin entries: ${filename}`);
  }
  if (config.skills !== undefined && (!config.skills || typeof config.skills !== "object" || Array.isArray(config.skills))) throw new SetupError("invalid_skill_config", `Invalid skills object: ${filename}`);
  for (const field of ["paths", "urls"]) if (config.skills?.[field] !== undefined && (!Array.isArray(config.skills[field]) || config.skills[field].some((source) => typeof source !== "string"))) throw new SetupError("invalid_skill_config", `Invalid skills.${field}: ${filename}`);
  return config;
}

export function pluginSource(entry) { return Array.isArray(entry) ? entry[0] : entry; }
export function isMemocap(entry) {
  const source = pluginSource(entry);
  return source === packageName || source.startsWith(`${packageName}@`);
}

export function configScopes(options, runtime) {
  const home = runtime.env.HOME || runtime.env.USERPROFILE;
  if (!home) throw new SetupError("missing_home", "HOME/USERPROFILE is required");
  const globalDirectory = path.join(runtime.env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode");
  const scopes = [];
  const requests = [...(options.global ? [{ kind: "global", directory: runtime.cwd }] : []), ...options.projects.map((directory) => ({ kind: "project", directory }))];
  for (const request of requests) {
    if (request.kind === "project" && (!fs.existsSync(request.directory) || !fs.statSync(request.directory).isDirectory())) throw new SetupError("invalid_project", request.directory);
    const directory = fs.realpathSync(request.directory);
    const parents = ancestors(directory);
    const configDirectories = [globalDirectory, ...parents.map((parent) => path.join(parent, ".opencode")), path.join(home, ".opencode"), ...(runtime.env.OPENCODE_CONFIG_DIR ? [path.resolve(runtime.cwd, runtime.env.OPENCODE_CONFIG_DIR)] : [])];
    const layers = [path.join(globalDirectory, "config.json"), ...configNames(globalDirectory)];
    if (runtime.env.OPENCODE_CONFIG) layers.push(path.resolve(runtime.cwd, runtime.env.OPENCODE_CONFIG));
    if (runtime.env.OPENCODE_DISABLE_PROJECT_CONFIG !== "true" && runtime.env.OPENCODE_DISABLE_PROJECT_CONFIG !== "1") for (const parent of [...parents].reverse()) layers.push(...configNames(parent));
    for (const configDirectory of configDirectories.slice(1)) layers.push(...configNames(configDirectory));
    const selectedDirectory = request.kind === "global" ? runtime.env.OPENCODE_CONFIG_DIR ? path.resolve(runtime.cwd, runtime.env.OPENCODE_CONFIG_DIR) : globalDirectory : directory;
    const config = options.config || (request.kind === "global" && runtime.env.OPENCODE_CONFIG ? path.resolve(runtime.cwd, runtime.env.OPENCODE_CONFIG) : preferredConfig(selectedDirectory));
    const position = layers.lastIndexOf(config);
    const higher = layers.slice(position < 0 ? 0 : position + 1);
    scopes.push({ kind: request.kind, directory, config, id: `${request.kind}:${request.kind === "global" ? config : directory}`, layers: [...new Set(layers)], config_directories: [...new Set(configDirectories)], higher_precedence: [...new Set(higher)], text: readText(config), home });
  }
  return scopes;
}

function configNames(directory) { return [path.join(directory, "opencode.json"), path.join(directory, "opencode.jsonc")]; }
function preferredConfig(directory) { return configNames(directory).find((filename) => fs.existsSync(filename)) || configNames(directory)[1]; }

export function managedConfigFiles(runtime) {
  const directory = runtime.env.OPENCODE_TEST_MANAGED_CONFIG_DIR || (runtime.platform === "darwin" ? "/Library/Application Support/opencode" : runtime.platform === "win32" ? path.join(runtime.env.ProgramData || "C:/ProgramData", "opencode") : "/etc/opencode");
  const files = configNames(directory);
  if (runtime.platform === "darwin") files.push(path.join("/Library/Managed Preferences", os.userInfo().username, "ai.opencode.managed.plist"), "/Library/Managed Preferences/ai.opencode.managed.plist");
  return files;
}

export function inspectConfig(scope, record, runtime) {
  const config = parseConfig(scope.config, scope.text);
  const entries = (config.plugin || []).filter(isMemocap);
  const configFiles = [...new Set([...scope.layers, scope.config])].filter((filename) => fs.existsSync(filename));
  const conflicts = [];
  if (!scope.layers.includes(scope.config)) conflicts.push({ code: "inactive_config", path: scope.config });
  for (const filename of configFiles) {
    const layer = parseConfig(filename);
    if (layer.skills?.urls?.length) conflicts.push({ code: "uninspected_skill_source", path: filename, urls: layer.skills.urls });
    if (layer.command?.memory) conflicts.push({ code: "memory_command_conflict", path: filename });
    for (const entry of layer.plugin || []) {
      if (!isMemocap(entry) && /memocap/i.test(pluginSource(entry))) conflicts.push({ code: "plugin_source_conflict", path: filename, source: pluginSource(entry) });
      if (isMemocap(entry) && filename !== scope.config) conflicts.push({ code: "plugin_layer_conflict", path: filename, source: pluginSource(entry) });
    }
  }
  for (const directory of scope.config_directories) {
    for (const name of ["command/memory.md", "commands/memory.md"]) if (fs.existsSync(path.join(directory, name))) conflicts.push({ code: "memory_command_conflict", path: path.join(directory, name) });
    for (const sub of ["plugin", "plugins"]) {
      const folder = path.join(directory, sub);
      if (fs.existsSync(folder)) for (const filename of fs.readdirSync(folder)) if (/memocap/i.test(filename)) conflicts.push({ code: "plugin_source_conflict", path: path.join(folder, filename) });
    }
  }
  if (runtime.env.OPENCODE_CONFIG_CONTENT) conflicts.push({ code: "content_only_config", path: "OPENCODE_CONFIG_CONTENT" });
  for (const filename of managedConfigFiles(runtime)) if (fs.existsSync(filename)) conflicts.push({ code: "managed_config", path: filename });
  if (entries.length > 1) conflicts.push({ code: "duplicate_plugin", path: scope.config });
  if (record?.plugin && entries.length && JSON.stringify(entries[0]) !== JSON.stringify(record.plugin.entry)) conflicts.push({ code: "plugin_modified", path: scope.config });
  const registrations = configFiles.flatMap((filename) => (parseConfig(filename).plugin || []).filter(isMemocap).map((entry) => ({ config: filename, entry })));
  return { config, entries, registrations, conflicts, digest: digest(scope.text) };
}

export function writePlugin(scope, entry) {
  const current = parseConfig(scope.config, scope.text);
  const entries = current.plugin || [];
  const index = entries.findIndex(isMemocap);
  const tuple = index >= 0 && Array.isArray(entries[index]);
  const location = current.plugin ? ["plugin", index < 0 ? -1 : index, ...(tuple ? [0] : [])] : ["plugin"];
  const replacement = tuple ? pluginSource(entry) : current.plugin ? entry : [entry];
  const edits = modify(scope.text ?? "{}\n", location, replacement, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: scope.text?.includes("\r\n") ? "\r\n" : "\n" } });
  const changed = applyEdits(scope.text ?? "{}\n", edits);
  return atomicWrite(scope.config, changed, scope.text);
}

export function removePlugin(scope, record) {
  const current = parseConfig(scope.config, scope.text);
  const index = (current.plugin || []).findIndex(isMemocap);
  if (index < 0) return { backup: null };
  if (!record?.plugin || JSON.stringify(current.plugin[index]) !== JSON.stringify(record.plugin.entry)) throw new SetupError("plugin_modified", `Preserving unowned or changed plugin: ${scope.config}`);
  const changed = removeArrayEntry(scope.text, ["plugin", index]);
  parseConfig(scope.config, changed);
  return atomicWrite(scope.config, changed, scope.text);
}

function removeArrayEntry(text, location) {
  const tree = parseTree(text, [], { allowTrailingComma: true });
  const node = findNodeAtLocation(tree, location);
  const edits = [{ offset: node.offset, length: node.length, content: "" }];
  // Keep trivia outside the owned value; jsonc-parser's array removal consumes it.
  const scanner = createScanner(text, true);
  scanner.setPosition(node.offset + node.length);
  if (scanner.scan() === SyntaxKind.CommaToken) {
    edits.push({ offset: scanner.getTokenOffset(), length: scanner.getTokenLength(), content: "" });
  } else if (location.at(-1) > 0) {
    const previous = findNodeAtLocation(tree, [...location.slice(0, -1), location.at(-1) - 1]);
    scanner.setPosition(previous.offset + previous.length);
    scanner.scan();
    edits.push({ offset: scanner.getTokenOffset(), length: scanner.getTokenLength(), content: "" });
  }
  return applyEdits(text, edits);
}

export function managedEntry(previous, target, directory) {
  const options = Array.isArray(previous) ? previous[1] : {};
  if (!options || typeof options !== "object" || Array.isArray(options) || (Array.isArray(previous) && previous.length !== 2)) throw new SetupError("invalid_plugin_config", "Expected plugin tuple [source, options]");
  return [`${packageName}@${target}`, { ...options, skillDirectory: directory }];
}

export function managedConfigText(scope, entry, ownedPaths = []) {
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: scope.text?.includes("\r\n") ? "\r\n" : "\n" };
  let changed = scope.text ?? "{}\n";
  const edit = (location, replacement) => { changed = applyEdits(changed, modify(changed, location, replacement, { formattingOptions })); };
  const current = parseConfig(scope.config, changed);
  const index = (current.plugin || []).findIndex(isMemocap);
  if (entry) {
    if (index >= 0 && Array.isArray(current.plugin[index])) {
      edit(["plugin", index, 0], entry[0]);
      edit(["plugin", index, 1, "skillDirectory"], entry[1].skillDirectory);
    } else edit(current.plugin ? ["plugin", index < 0 ? -1 : index] : ["plugin"], current.plugin ? entry : [entry]);
  } else if (index >= 0) changed = removeArrayEntry(changed, ["plugin", index]);
  for (const directory of ownedPaths) {
    const paths = parseConfig(scope.config, changed).skills?.paths || [];
    const offset = paths.indexOf(directory);
    if (offset >= 0 && directory !== entry?.[1].skillDirectory) changed = removeArrayEntry(changed, ["skills", "paths", offset]);
  }
  if (entry) {
    const paths = parseConfig(scope.config, changed).skills?.paths;
    if (!paths?.includes(entry[1].skillDirectory)) edit(paths ? ["skills", "paths", -1] : ["skills", "paths"], paths ? entry[1].skillDirectory : [entry[1].skillDirectory]);
  }
  parseConfig(scope.config, changed);
  return changed;
}

export function writeManagedConfig(scope, intent) {
  const current = parseConfig(scope.config, scope.text);
  const existing = (current.plugin || []).find(isMemocap);
  if (!intent.entry && existing && JSON.stringify(existing) !== JSON.stringify(intent.previous_entry)) throw new SetupError("plugin_modified", `Preserving changed plugin: ${scope.config}`);
  const changed = managedConfigText(scope, intent.entry, intent.remove_paths);
  if (changed === scope.text) return { status: "unchanged", backup: null, digest: digest(changed) };
  const saved = atomicWrite(scope.config, changed, scope.text);
  if (readText(scope.config) !== changed) throw new SetupError("config_outcome_unknown", `Config commit readback differs: ${scope.config}`);
  return { ...saved, status: "changed" };
}
