import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, posix, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;
const RESERVED_COMPONENTS = new Set([".git", ".letta"]);

export interface MemfsStructure {
  /** UTF-8 file contents keyed by path relative to the MemFS root. */
  files?: Readonly<Record<string, string>>;
  /** Directories to materialize even when they contain no tracked files. */
  directories?: readonly string[];
}

export interface ValidatedMemfsStructure {
  files: readonly { path: string; content: string }[];
  directories: readonly string[];
}

export type MemfsOperation = "create" | "modify" | "delete";

export interface MemfsOperationRule {
  /** Exact relative path, or directory path when recursive is true. */
  path: string;
  recursive?: boolean;
  operations: readonly MemfsOperation[];
}

/**
 * Default policy semantics:
 * - paths in existingPaths may be modified (but not created or deleted);
 * - paths below allowedNewFilePrefixes may be created, modified, or deleted;
 * - everything else is denied.
 *
 * A matching allowedOperations rule overrides those defaults. This permits,
 * for example, an existing AGENTS.md to be modifiable but not deletable.
 */
export interface MemfsWritePolicy {
  existingPaths: readonly string[];
  allowedNewFilePrefixes?: readonly string[];
  allowedOperations?: readonly MemfsOperationRule[];
  /** Empty directories that must be recreated after a Git clone. */
  declaredDirectories?: readonly string[];
}

interface NormalizedPolicy {
  existingPaths: readonly string[];
  allowedNewFilePrefixes: readonly string[];
  allowedOperations: readonly Required<MemfsOperationRule>[];
  declaredDirectories: readonly string[];
}

export interface MemfsGuardInstallation {
  hooksDir: string;
  preCommitPath: string;
  postCommitPath: string;
  /** Directories present when the guard was installed, excluding .git. */
  baselineDirectories: readonly string[];
}

export interface MemfsPolicyViolation {
  path: string;
  operation?: MemfsOperation;
  source: "commit" | "working-tree" | "untracked" | "directory";
  commit?: string;
  reason: string;
}

export interface MemfsValidationResult {
  valid: boolean;
  violations: readonly MemfsPolicyViolation[];
}

function normalizeRelativePath(input: string, kind: "file" | "directory"): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error(`MemFS ${kind} path must be a non-empty string`);
  }
  if (input.includes("\0") || /[\x00-\x1f\x7f]/.test(input)) {
    throw new Error(`Invalid MemFS path ${JSON.stringify(input)}: control characters are not allowed`);
  }
  if (input.includes("\\")) {
    throw new Error(`Invalid MemFS path ${JSON.stringify(input)}: use POSIX '/' separators`);
  }
  if (isAbsolute(input) || input.startsWith("/")) {
    throw new Error(`Invalid MemFS path ${JSON.stringify(input)}: paths must be relative`);
  }

  const withoutTrailingSlash = kind === "directory" ? input.replace(/\/+$/, "") : input;
  const parts = withoutTrailingSlash.split("/");
  if (
    withoutTrailingSlash.length === 0 ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Invalid MemFS path ${JSON.stringify(input)}: traversal and empty segments are not allowed`);
  }
  const reserved = parts.find((part) => RESERVED_COMPONENTS.has(part));
  if (reserved) {
    throw new Error(`Invalid MemFS path ${JSON.stringify(input)}: ${reserved} is reserved`);
  }

  const normalized = posix.normalize(withoutTrailingSlash);
  if (normalized !== withoutTrailingSlash) {
    throw new Error(`Invalid MemFS path ${JSON.stringify(input)}: path must already be normalized`);
  }
  return normalized;
}

function uniqueSorted(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort((a, b) => a.localeCompare(b));
}

function parentPaths(path: string): string[] {
  const result: string[] = [];
  let current = posix.dirname(path);
  while (current !== ".") {
    result.push(current);
    current = posix.dirname(current);
  }
  return result;
}

export function validateMemfsStructure(
  structure: MemfsStructure,
): ValidatedMemfsStructure {
  if (!structure || typeof structure !== "object") {
    throw new Error("MemFS structure must be an object");
  }

  const files = Object.entries(structure.files ?? {}).map(([rawPath, content]) => {
    if (typeof content !== "string") {
      throw new Error(`MemFS file ${JSON.stringify(rawPath)} must contain a string`);
    }
    return { path: normalizeRelativePath(rawPath, "file"), content };
  });
  files.sort((a, b) => a.path.localeCompare(b.path));
  const directories = uniqueSorted(
    (structure.directories ?? []).map((path) =>
      normalizeRelativePath(path, "directory"),
    ),
  );

  const filePaths = new Set(files.map((file) => file.path));
  for (const directory of directories) {
    if (filePaths.has(directory)) {
      throw new Error(`MemFS path ${directory} cannot be both a file and a directory`);
    }
  }
  for (const file of files) {
    for (const parent of parentPaths(file.path)) {
      if (filePaths.has(parent)) {
        throw new Error(`MemFS file ${parent} conflicts with descendant ${file.path}`);
      }
    }
  }
  for (const directory of directories) {
    for (const parent of parentPaths(directory)) {
      if (filePaths.has(parent)) {
        throw new Error(`MemFS file ${parent} conflicts with directory ${directory}`);
      }
    }
  }

  return { files, directories };
}

export function createMemfsWritePolicy(
  structure: MemfsStructure | ValidatedMemfsStructure,
  options: {
    allowedNewFilePrefixes?: readonly string[];
    allowedOperations?: readonly MemfsOperationRule[];
  } = {},
): MemfsWritePolicy {
  const validated = Array.isArray((structure as ValidatedMemfsStructure).files)
    ? (structure as ValidatedMemfsStructure)
    : validateMemfsStructure(structure as MemfsStructure);
  return validateMemfsWritePolicy({
    existingPaths: validated.files.map((file) => file.path),
    declaredDirectories: validated.directories,
    allowedNewFilePrefixes: options.allowedNewFilePrefixes,
    allowedOperations: options.allowedOperations,
  });
}

export function validateMemfsWritePolicy(
  policy: MemfsWritePolicy,
): MemfsWritePolicy {
  const normalized = normalizePolicy(policy);
  return {
    existingPaths: normalized.existingPaths,
    allowedNewFilePrefixes: normalized.allowedNewFilePrefixes,
    allowedOperations: normalized.allowedOperations,
    declaredDirectories: normalized.declaredDirectories,
  };
}

function normalizePolicy(policy: MemfsWritePolicy): NormalizedPolicy {
  if (!policy || typeof policy !== "object") {
    throw new Error("MemFS write policy must be an object");
  }
  const existingPaths = uniqueSorted(
    (policy.existingPaths ?? []).map((path) => normalizeRelativePath(path, "file")),
  );
  const allowedNewFilePrefixes = uniqueSorted(
    (policy.allowedNewFilePrefixes ?? []).map((path) =>
      normalizeRelativePath(path, "directory"),
    ),
  );
  const declaredDirectories = uniqueSorted(
    (policy.declaredDirectories ?? []).map((path) =>
      normalizeRelativePath(path, "directory"),
    ),
  );
  const allowedOperations = (policy.allowedOperations ?? []).map((rule) => {
    if (!rule || typeof rule !== "object") {
      throw new Error("MemFS operation rule must be an object");
    }
    const operations = [...new Set(rule.operations ?? [])];
    if (
      operations.length === 0 ||
      operations.some(
        (operation) =>
          operation !== "create" && operation !== "modify" && operation !== "delete",
      )
    ) {
      throw new Error(`Invalid MemFS operations for ${JSON.stringify(rule.path)}`);
    }
    return {
      path: normalizeRelativePath(rule.path, rule.recursive ? "directory" : "file"),
      recursive: rule.recursive ?? false,
      operations,
    } satisfies Required<MemfsOperationRule>;
  });
  allowedOperations.sort(
    (a, b) =>
      b.path.length - a.path.length ||
      Number(a.recursive) - Number(b.recursive) ||
      a.path.localeCompare(b.path),
  );
  return {
    existingPaths,
    allowedNewFilePrefixes,
    allowedOperations,
    declaredDirectories,
  };
}

async function assertNoSymlinkTraversal(root: string, relativePath: string): Promise<void> {
  let current = root;
  for (const component of relativePath.split("/")) {
    current = join(current, component);
    const info = await lstat(current).catch(() => null);
    if (info?.isSymbolicLink()) {
      throw new Error(`Refusing to materialize MemFS path through symlink: ${relativePath}`);
    }
  }
}

export async function recreateMemfsDirectories(
  memoryDir: string,
  directories: readonly string[],
): Promise<readonly string[]> {
  const normalized = uniqueSorted(
    directories.map((path) => normalizeRelativePath(path, "directory")),
  ).sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  for (const directory of normalized) {
    await assertNoSymlinkTraversal(memoryDir, directory);
    const destination = join(memoryDir, ...directory.split("/"));
    const info = await lstat(destination).catch(() => null);
    if (info && !info.isDirectory()) {
      throw new Error(`Cannot materialize MemFS directory ${directory}: a file already exists there`);
    }
    await mkdir(destination, { recursive: true });
  }
  return normalized;
}

export async function materializeMemfsStructure(
  memoryDir: string,
  structure: MemfsStructure,
): Promise<ValidatedMemfsStructure> {
  const validated = validateMemfsStructure(structure);
  await mkdir(memoryDir, { recursive: true });
  await recreateMemfsDirectories(memoryDir, validated.directories);
  for (const file of validated.files) {
    await assertNoSymlinkTraversal(memoryDir, file.path);
    const destination = join(memoryDir, ...file.path.split("/"));
    const info = await lstat(destination).catch(() => null);
    if (info?.isDirectory()) {
      throw new Error(`Cannot materialize MemFS file ${file.path}: a directory already exists there`);
    }
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.content, "utf-8");
  }
  return validated;
}

async function gitRaw(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    encoding: "utf-8",
    maxBuffer: MAX_GIT_OUTPUT,
  });
  return stdout;
}

async function gitCommonDir(memoryDir: string): Promise<string> {
  const raw = (await gitRaw(memoryDir, ["rev-parse", "--git-common-dir"])).trim();
  return isAbsolute(raw) ? raw : resolve(memoryDir, raw);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function operationCase(operations: readonly MemfsOperation[]): string {
  return operations.map(shellQuote).join("|");
}

function buildPolicyShell(policy: NormalizedPolicy): string {
  const rules = policy.allowedOperations
    .map((rule) => {
      const allowed = operationCase(rule.operations);
      if (rule.recursive) {
        return `  case "$path" in\n    ${shellQuote(`${rule.path}/`)}*)\n      case "$operation" in ${allowed}) return 0 ;; *) return 1 ;; esac\n      ;;\n  esac`;
      }
      return `  if [ "$path" = ${shellQuote(rule.path)} ]; then\n    case "$operation" in ${allowed}) return 0 ;; *) return 1 ;; esac\n  fi`;
    })
    .join("\n");
  const existing = policy.existingPaths.length
    ? `  case "$path" in\n    ${policy.existingPaths.map(shellQuote).join("|")})\n      case "$operation" in 'modify') return 0 ;; *) return 1 ;; esac\n      ;;\n  esac`
    : "";
  const prefixes = policy.allowedNewFilePrefixes
    .map(
      (prefix) =>
        `  case "$path" in ${shellQuote(`${prefix}/`)}*) return 0 ;; esac`,
    )
    .join("\n");
  return [rules, prefixes, existing].filter(Boolean).join("\n");
}

function buildDirectoryShell(
  policy: NormalizedPolicy,
  baselineDirectories: readonly string[],
): string {
  const ancestors = [
    ...policy.existingPaths.flatMap(parentPaths),
    ...policy.declaredDirectories,
    ...policy.declaredDirectories.flatMap(parentPaths),
    ...policy.allowedNewFilePrefixes,
    ...policy.allowedNewFilePrefixes.flatMap(parentPaths),
    ...baselineDirectories,
  ];
  const exact = uniqueSorted(ancestors);
  const exactCase = exact.length
    ? `    ${exact.map(shellQuote).join("|")}) return 0 ;;`
    : "";
  const prefixCases = policy.allowedNewFilePrefixes
    .map((prefix) => `    ${shellQuote(`${prefix}/`)}*) return 0 ;;`)
    .join("\n");
  return [exactCase, prefixCases].filter(Boolean).join("\n");
}

function buildPreCommitHook(
  policy: NormalizedPolicy,
  baselineDirectories: readonly string[],
  nativePreCommitPath: string,
): string {
  return `#!/usr/bin/env bash
set -u

violations=0

operation_for_status() {
  case "$1" in
    A) printf '%s' create ;;
    M) printf '%s' modify ;;
    D) printf '%s' delete ;;
    *) return 1 ;;
  esac
}

path_allowed() {
  operation="$1"
  path="$2"
  case "$path" in
    .git|.git/*|.letta|.letta/*) return 1 ;;
  esac
${buildPolicyShell(policy)}
  return 1
}

report_change() {
  status="$1"
  path="$2"
  source="$3"
  operation=$(operation_for_status "$status") || {
    printf 'MemFS guard: %s has unsupported git status %s (%s)\n' "$path" "$status" "$source" >&2
    violations=1
    return
  }
  if ! path_allowed "$operation" "$path"; then
    printf 'MemFS guard: %s of %s is not allowed (%s)\n' "$operation" "$path" "$source" >&2
    violations=1
  fi
}

report_index_mode() {
  status="$1"
  path="$2"
  [ "$status" = D ] && return
  mode=$(git ls-files --stage -- "$path" | head -n 1 | cut -d' ' -f1)
  case "$mode" in
    100644|100755) ;;
    *)
      printf 'MemFS guard: %s has disallowed staged mode %s (symlinks and submodules are not allowed)\n' "$path" "\${mode:-missing}" >&2
      violations=1
      ;;
  esac
}

while IFS= read -r -d '' status && IFS= read -r -d '' path; do
  report_change "$status" "$path" staged
  report_index_mode "$status" "$path"
done < <(git diff --cached --name-status -z --no-renames)

while IFS= read -r -d '' status && IFS= read -r -d '' path; do
  report_change "$status" "$path" unstaged
  if [ "$status" != D ] && { [ -L "$path" ] || [ ! -f "$path" ]; }; then
    printf 'MemFS guard: %s is not a regular file\n' "$path" >&2
    violations=1
  fi
done < <(git diff --name-status -z --no-renames)

while IFS= read -r -d '' path; do
  report_change A "$path" untracked
  if [ -L "$path" ] || [ ! -f "$path" ]; then
    printf 'MemFS guard: %s is not a regular file\n' "$path" >&2
    violations=1
  fi
done < <(git ls-files --others --exclude-standard -z)

directory_allowed() {
  path="$1"
  case "$path" in
${buildDirectoryShell(policy, baselineDirectories)}
  esac
  return 1
}

while IFS= read -r -d '' directory; do
  path="\${directory#./}"
  [ "$path" = . ] && continue
  case "$path" in .git|.git/*) continue ;; esac
  if ! directory_allowed "$path"; then
    printf 'MemFS guard: directory %s is outside the allowed structure\n' "$path" >&2
    violations=1
  fi
done < <(find . -path ./.git -prune -o -type d -print0)

if [ "$violations" -ne 0 ]; then
  exit 1
fi

native_pre_commit=${shellQuote(nativePreCommitPath)}
if [ -x "$native_pre_commit" ]; then
  exec "$native_pre_commit" "$@"
fi
exit 0
`;
}

function buildPostCommitHook(nativePostCommitPath: string): string {
  return `#!/usr/bin/env bash
native_post_commit=${shellQuote(nativePostCommitPath)}
if [ -x "$native_post_commit" ]; then
  exec "$native_post_commit" "$@"
fi
exit 0
`;
}

async function listWorktreeDirectories(memoryDir: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(absolute: string, relative: string): Promise<void> {
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      if (relative === "" && entry.name === ".git") continue;
      if (!entry.isDirectory()) continue;
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      result.push(childRelative);
      await visit(join(absolute, entry.name), childRelative);
    }
  }
  await visit(memoryDir, "");
  return uniqueSorted(result);
}

export async function installMemfsGuard(
  memoryDir: string,
  policy: MemfsWritePolicy,
): Promise<MemfsGuardInstallation> {
  const normalized = normalizePolicy(policy);
  const commonDir = await gitCommonDir(memoryDir);
  const nativeHooksDir = join(commonDir, "hooks");
  const hooksDir = join(commonDir, "dream-hooks");
  const preCommitPath = join(hooksDir, "pre-commit");
  const postCommitPath = join(hooksDir, "post-commit");
  const baselineDirectories = await listWorktreeDirectories(memoryDir);

  await mkdir(hooksDir, { recursive: true });
  await writeFile(
    preCommitPath,
    buildPreCommitHook(
      normalized,
      baselineDirectories,
      join(nativeHooksDir, "pre-commit"),
    ),
    "utf-8",
  );
  await writeFile(
    postCommitPath,
    buildPostCommitHook(join(nativeHooksDir, "post-commit")),
    "utf-8",
  );
  await chmod(preCommitPath, 0o755);
  await chmod(postCommitPath, 0o755);
  await gitRaw(memoryDir, ["config", "--local", "core.hooksPath", hooksDir]);
  return {
    hooksDir,
    preCommitPath,
    postCommitPath,
    baselineDirectories,
  };
}

async function copyNativeHook(
  sourceMemoryDir: string,
  cloneMemoryDir: string,
  name: "pre-commit" | "post-commit",
): Promise<void> {
  const source = join(await gitCommonDir(sourceMemoryDir), "hooks", name);
  const destination = join(await gitCommonDir(cloneMemoryDir), "hooks", name);
  const sourceInfo = await stat(source).catch(() => null);
  if (!sourceInfo?.isFile()) return;
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  await chmod(destination, 0o755);
}

/** Configure a freshly cloned MemFS repo, whose hooks and local config Git did not copy. */
export async function configureMemfsCloneGuard(
  sourceMemoryDir: string,
  cloneMemoryDir: string,
  policy: MemfsWritePolicy,
): Promise<MemfsGuardInstallation> {
  const normalized = normalizePolicy(policy);
  await recreateMemfsDirectories(cloneMemoryDir, normalized.declaredDirectories);
  await copyNativeHook(sourceMemoryDir, cloneMemoryDir, "pre-commit");
  await copyNativeHook(sourceMemoryDir, cloneMemoryDir, "post-commit");
  return installMemfsGuard(cloneMemoryDir, normalized);
}

function pathOperationAllowed(
  path: string,
  operation: MemfsOperation,
  policy: NormalizedPolicy,
): boolean {
  let normalizedPath: string;
  try {
    normalizedPath = normalizeRelativePath(path, "file");
  } catch {
    return false;
  }
  for (const rule of policy.allowedOperations) {
    const matches = rule.recursive
      ? normalizedPath.startsWith(`${rule.path}/`)
      : normalizedPath === rule.path;
    if (matches) return rule.operations.includes(operation);
  }
  if (
    policy.allowedNewFilePrefixes.some((prefix) =>
      normalizedPath.startsWith(`${prefix}/`),
    )
  ) {
    return true;
  }
  if (policy.existingPaths.includes(normalizedPath)) {
    return operation === "modify";
  }
  return false;
}

function parseNameStatus(raw: string): { status: string; path: string }[] {
  const fields = raw.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const result: { status: string; path: string }[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index];
    const path = fields[index + 1];
    if (status !== undefined && path !== undefined) result.push({ status, path });
  }
  return result;
}

function operationFromStatus(status: string): MemfsOperation | null {
  if (status === "A") return "create";
  if (status === "M") return "modify";
  if (status === "D") return "delete";
  return null;
}

async function committedMode(
  memoryDir: string,
  revision: string,
  path: string,
): Promise<string | null> {
  const raw = await gitRaw(memoryDir, ["ls-tree", "-z", revision, "--", path]);
  return raw.match(/^(\d+) /)?.[1] ?? null;
}

async function validateChangeSet(
  memoryDir: string,
  entries: readonly { status: string; path: string }[],
  policy: NormalizedPolicy,
  source: MemfsPolicyViolation["source"],
  violations: MemfsPolicyViolation[],
  options: { revision?: string; commit?: string } = {},
): Promise<void> {
  for (const entry of entries) {
    const operation = operationFromStatus(entry.status);
    if (!operation || !pathOperationAllowed(entry.path, operation, policy)) {
      violations.push({
        path: entry.path,
        ...(operation ? { operation } : {}),
        source,
        ...(options.commit ? { commit: options.commit } : {}),
        reason: operation
          ? `${operation} is outside the MemFS write policy`
          : `unsupported git status ${entry.status}`,
      });
      continue;
    }
    if (operation === "delete") continue;

    let regular = false;
    if (options.revision) {
      const mode = await committedMode(memoryDir, options.revision, entry.path);
      regular = mode === "100644" || mode === "100755";
    } else {
      const info = await lstat(join(memoryDir, ...entry.path.split("/"))).catch(
        () => null,
      );
      regular = info?.isFile() === true && !info.isSymbolicLink();
    }
    if (!regular) {
      violations.push({
        path: entry.path,
        operation,
        source,
        ...(options.commit ? { commit: options.commit } : {}),
        reason: "only regular files are allowed (no symlinks or submodules)",
      });
    }
  }
}

function allowedDirectorySet(
  policy: NormalizedPolicy,
  baselineDirectories: readonly string[],
): Set<string> {
  return new Set([
    ...baselineDirectories,
    ...policy.existingPaths.flatMap(parentPaths),
    ...policy.declaredDirectories,
    ...policy.declaredDirectories.flatMap(parentPaths),
    ...policy.allowedNewFilePrefixes,
    ...policy.allowedNewFilePrefixes.flatMap(parentPaths),
  ]);
}

/**
 * Defense-in-depth validation after an agent run. Every commit is inspected,
 * so an illegal add followed by a delete cannot disappear in an endpoint diff.
 */
export async function validateMemfsChanges(
  memoryDir: string,
  baseRevision: string,
  policy: MemfsWritePolicy,
  options: { baselineDirectories?: readonly string[] } = {},
): Promise<MemfsValidationResult> {
  const normalized = normalizePolicy(policy);
  const violations: MemfsPolicyViolation[] = [];
  const commits = (await gitRaw(memoryDir, ["rev-list", "--reverse", `${baseRevision}..HEAD`]))
    .trim()
    .split("\n")
    .filter(Boolean);

  for (const commit of commits) {
    const parent = (await gitRaw(memoryDir, ["rev-parse", `${commit}^1`])).trim();
    const entries = parseNameStatus(
      await gitRaw(memoryDir, [
        "diff",
        "--name-status",
        "-z",
        "--no-renames",
        parent,
        commit,
      ]),
    );
    await validateChangeSet(memoryDir, entries, normalized, "commit", violations, {
      revision: commit,
      commit,
    });
  }

  const workingEntries = parseNameStatus(
    await gitRaw(memoryDir, [
      "diff",
      "--name-status",
      "-z",
      "--no-renames",
      "HEAD",
    ]),
  );
  await validateChangeSet(
    memoryDir,
    workingEntries,
    normalized,
    "working-tree",
    violations,
  );

  const untracked = (await gitRaw(memoryDir, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]))
    .split("\0")
    .filter(Boolean)
    .map((path) => ({ status: "A", path }));
  await validateChangeSet(
    memoryDir,
    untracked,
    normalized,
    "untracked",
    violations,
  );

  const baselineDirectories = options.baselineDirectories ?? [".letta"];
  const allowedDirectories = allowedDirectorySet(normalized, baselineDirectories);
  for (const directory of await listWorktreeDirectories(memoryDir)) {
    if (
      allowedDirectories.has(directory) ||
      normalized.allowedNewFilePrefixes.some((prefix) =>
        directory.startsWith(`${prefix}/`),
      )
    ) {
      continue;
    }
    violations.push({
      path: directory,
      source: "directory",
      reason: "directory is outside the MemFS write policy",
    });
  }

  return { valid: violations.length === 0, violations };
}

/** Read a materialized file in tests/callers without exposing path traversal. */
export async function readMemfsFile(memoryDir: string, path: string): Promise<string> {
  const normalized = normalizeRelativePath(path, "file");
  return readFile(join(memoryDir, ...normalized.split("/")), "utf-8");
}
