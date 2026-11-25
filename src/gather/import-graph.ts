import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  type Stats,
} from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { isWithinRealRoot, normalizeRepoPath, resolveRealRepoRoot } from './git.js';
import type { FileSnippet, ImportGraphResult } from './types.js';

const SKIPPED_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.tox',
]);

const SKIPPED_REL_PREFIXES = ['bench/cases'] as const;

const JS_TS_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
] as const;

const JS_TS_EXTENSION_SET = new Set<string>(JS_TS_EXTENSIONS);

const JS_TO_TS_FALLBACKS: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.ts', '.tsx', '.mts', '.cts', '.jsx', '.mjs', '.cjs'],
  '.jsx': ['.tsx', '.ts'],
  '.mjs': ['.mts', '.ts'],
  '.cjs': ['.cts', '.ts'],
};

const MAX_READABLE_FILE_BYTES = 512 * 1024;
const PYTHON_SOURCE_ROOTS = ['', 'src', 'lib'] as const;

function getFileExtension(filePath: string): string {
  const base = posix.basename(filePath);
  const dotIdx = base.lastIndexOf('.');
  if (dotIdx <= 0) {
    return '';
  }
  return base.slice(dotIdx).toLowerCase();
}

export function isSupportedCodeFile(repoRelPath: string): boolean {
  const ext = getFileExtension(repoRelPath);
  return ext === '.py' || JS_TS_EXTENSION_SET.has(ext);
}

export function isTestFile(repoRelPath: string): boolean {
  const normalized = normalizeRepoPath(repoRelPath);
  if (normalized.length === 0) {
    return false;
  }

  const segments = normalized.split('/');
  const basename = segments[segments.length - 1] ?? '';

  if (/\.(?:test|spec)\.[^./]+$/i.test(basename)) {
    return true;
  }

  if (/^test_.*\.py$/i.test(basename) || /_test\.py$/i.test(basename)) {
    return true;
  }

  const dirSegments = segments.slice(0, -1);
  const inTestDir = dirSegments.some(
    (seg) => seg === 'test' || seg === 'tests' || seg === '__tests__',
  );

  return inTestDir && isSupportedCodeFile(normalized);
}

function isSkippedRelativePath(relPath: string): boolean {
  for (const prefix of SKIPPED_REL_PREFIXES) {
    if (relPath === prefix || relPath.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  return false;
}

function walkRepoCodeFiles(cwd: string): string[] {
  const realRoot = resolveRealRepoRoot(cwd);
  if (realRoot === null) {
    return [];
  }

  const files: string[] = [];
  const visitedRealDirs = new Set<string>([realRoot]);

  const walk = (absDir: string, relDir: string): void => {
    let entries: Array<{
      name: string;
      isDirectory: () => boolean;
      isFile: () => boolean;
      isSymbolicLink: () => boolean;
    }>;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const name = entry.name;
      const relPath = relDir.length > 0 ? `${relDir}/${name}` : name;
      const fullPath = join(absDir, name);

      if (entry.isSymbolicLink()) {
        let realTarget: string;
        let targetStats: Stats;
        try {
          realTarget = realpathSync(fullPath);
          if (!isWithinRealRoot(realRoot, realTarget)) {
            continue;
          }
          targetStats = statSync(realTarget);
        } catch {
          continue;
        }

        if (targetStats.isDirectory()) {
          if (
            SKIPPED_DIR_NAMES.has(name) ||
            isSkippedRelativePath(relPath) ||
            visitedRealDirs.has(realTarget)
          ) {
            continue;
          }
          visitedRealDirs.add(realTarget);
          walk(fullPath, relPath);
          continue;
        }

        if (
          targetStats.isFile() &&
          isSupportedCodeFile(relPath) &&
          !isSkippedRelativePath(relPath)
        ) {
          files.push(relPath);
        }
        continue;
      }

      if (entry.isDirectory()) {
        if (SKIPPED_DIR_NAMES.has(name) || isSkippedRelativePath(relPath)) {
          continue;
        }
        let realDir: string;
        try {
          realDir = realpathSync(fullPath);
        } catch {
          continue;
        }
        if (!isWithinRealRoot(realRoot, realDir) || visitedRealDirs.has(realDir)) {
          continue;
        }
        visitedRealDirs.add(realDir);
        walk(fullPath, relPath);
        continue;
      }

      if (entry.isFile() && isSupportedCodeFile(relPath) && !isSkippedRelativePath(relPath)) {
        let realFile: string;
        try {
          realFile = realpathSync(fullPath);
        } catch {
          continue;
        }
        if (!isWithinRealRoot(realRoot, realFile)) {
          continue;
        }
        files.push(relPath);
      }
    }
  };

  walk(cwd, '');
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

export function readFileContentSafe(cwd: string, relPath: string): string | null {
  const realRoot = resolveRealRepoRoot(cwd);
  if (realRoot === null) {
    return null;
  }

  const fullPath = resolve(cwd, relPath);
  try {
    const lstats = lstatSync(fullPath);
    const realPath = realpathSync(fullPath);
    if (!isWithinRealRoot(realRoot, realPath)) {
      return null;
    }

    const stats = lstats.isSymbolicLink() ? statSync(realPath) : lstats;
    if (!stats.isFile() || stats.size > MAX_READABLE_FILE_BYTES) {
      return null;
    }
    const buf = readFileSync(realPath);
    const sniffLen = Math.min(buf.length, 4096);
    for (let i = 0; i < sniffLen; i += 1) {
      if (buf[i] === 0) {
        return null;
      }
    }
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

function stripJsComments(source: string): string {
  let out = '';
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inBlockComment = false;
  let inLineComment = false;
  const templateExprDepths: number[] = [];

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i] ?? '';
    const next = source[i + 1] ?? '';

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        out += '\n';
      } else {
        out += ' ';
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        out += '  ';
        i += 1;
      } else {
        out += ch === '\n' ? '\n' : ' ';
      }
      continue;
    }

    if (inSingle) {
      out += ch;
      if (ch === '\\' && next.length > 0) {
        out += next;
        i += 1;
      } else if (ch === "'" || ch === '\n') {
        inSingle = false;
      }
      continue;
    }

    if (inDouble) {
      out += ch;
      if (ch === '\\' && next.length > 0) {
        out += next;
        i += 1;
      } else if (ch === '"' || ch === '\n') {
        inDouble = false;
      }
      continue;
    }

    if (inTemplate) {
      if (ch === '\\' && next.length > 0) {
        out += ch + next;
        i += 1;
        continue;
      }
      if (ch === '$' && next === '{') {
        inTemplate = false;
        templateExprDepths.push(0);
        out += '${';
        i += 1;
        continue;
      }
      out += ch;
      if (ch === '`') {
        inTemplate = false;
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      out += '  ';
      i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true;
      out += '  ';
      i += 1;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === '`') {
      inTemplate = true;
    } else if (templateExprDepths.length > 0) {
      const topIdx = templateExprDepths.length - 1;
      const topDepth = templateExprDepths[topIdx];
      if (topDepth !== undefined) {
        if (ch === '{') {
          templateExprDepths[topIdx] = topDepth + 1;
        } else if (ch === '}') {
          if (topDepth === 0) {
            templateExprDepths.pop();
            inTemplate = true;
          } else {
            templateExprDepths[topIdx] = topDepth - 1;
          }
        }
      }
    }

    out += ch;
  }

  return out;
}

export function extractJsTsImports(source: string): string[] {
  const cleaned = stripJsComments(source);
  const specifiers = new Set<string>();

  const addIfLocal = (rawSpec: string | undefined): void => {
    if (!rawSpec) {
      return;
    }
    const spec = rawSpec.trim();
    if (
      spec === '.' ||
      spec === '..' ||
      spec.startsWith('./') ||
      spec.startsWith('../')
    ) {
      specifiers.add(spec);
    }
  };

  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^;'"=]*?)(?:\s+|(?<=[}*]))from\s*['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  for (const pattern of patterns) {
    let match = pattern.exec(cleaned);
    while (match !== null) {
      addIfLocal(match[1]);
      match = pattern.exec(cleaned);
    }
  }

  return Array.from(specifiers);
}

export function resolveJsTsImport(
  fromFile: string,
  specifier: string,
  fileSet: ReadonlySet<string>,
): string | null {
  const fromDir = posix.dirname(fromFile);
  const joined = posix.normalize(posix.join(fromDir === '.' ? '' : fromDir, specifier));
  const normalized = joined === '.' ? '' : joined.replace(/^(?:\.\/)+/, '');

  if (normalized === '..' || normalized.startsWith('../')) {
    return null;
  }

  if (normalized.length > 0 && fileSet.has(normalized)) {
    return normalized;
  }

  const ext = getFileExtension(normalized);
  if (ext.length > 0) {
    const fallbacks = JS_TO_TS_FALLBACKS[ext];
    if (fallbacks) {
      const stem = normalized.slice(0, -ext.length);
      for (const altExt of fallbacks) {
        const candidate = `${stem}${altExt}`;
        if (fileSet.has(candidate)) {
          return candidate;
        }
      }
    }
  }

  if (normalized.length > 0) {
    for (const candidateExt of JS_TS_EXTENSIONS) {
      const candidate = `${normalized}${candidateExt}`;
      if (fileSet.has(candidate)) {
        return candidate;
      }
    }
  }

  const indexPrefix = normalized.length > 0 ? `${normalized}/index` : 'index';
  for (const candidateExt of JS_TS_EXTENSIONS) {
    const candidate = `${indexPrefix}${candidateExt}`;
    if (fileSet.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

export interface PythonImportSpec {
  kind: 'from' | 'import';
  dots: number;
  module: string;
  names: string[];
}

function stripPythonLineComment(line: string): string {
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inSingle) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === "'") {
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === '#') {
      return line.slice(0, i);
    }
  }

  return line;
}

function collectPythonLogicalLines(source: string): string[] {
  const rawLines = source.replace(/\r\n?/g, '\n').split('\n');
  const logicalLines: string[] = [];
  let inTripleQuote: '"""' | "'''" | null = null;
  let buffer = '';
  let parenDepth = 0;

  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();

    if (inTripleQuote !== null) {
      if (trimmed.includes(inTripleQuote)) {
        inTripleQuote = null;
      }
      continue;
    }

    if (buffer.length === 0) {
      if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
        const delim: '"""' | "'''" = trimmed.startsWith('"""') ? '"""' : "'''";
        const afterOpening = trimmed.slice(3);
        if (!afterOpening.includes(delim)) {
          inTripleQuote = delim;
        }
        continue;
      }
    }

    const withoutComment = stripPythonLineComment(rawLine).trim();
    if (withoutComment.length === 0) {
      if (buffer.length > 0 && parenDepth === 0) {
        logicalLines.push(buffer);
        buffer = '';
      }
      continue;
    }

    const continuesLine = withoutComment.endsWith('\\');
    const piece = continuesLine ? withoutComment.slice(0, -1).trimEnd() : withoutComment;

    let inSingle = false;
    let inDouble = false;
    for (let idx = 0; idx < piece.length; idx += 1) {
      const ch = piece[idx];
      if (inSingle) {
        if (ch === '\\') {
          idx += 1;
        } else if (ch === "'") {
          inSingle = false;
        }
        continue;
      }
      if (inDouble) {
        if (ch === '\\') {
          idx += 1;
        } else if (ch === '"') {
          inDouble = false;
        }
        continue;
      }
      if (ch === "'") {
        inSingle = true;
      } else if (ch === '"') {
        inDouble = true;
      } else if (ch === '(') {
        parenDepth += 1;
      } else if (ch === ')') {
        parenDepth = Math.max(0, parenDepth - 1);
      }
    }

    buffer = buffer.length === 0 ? piece : `${buffer} ${piece}`;

    if (!continuesLine && parenDepth === 0) {
      logicalLines.push(buffer);
      buffer = '';
    }
  }

  if (buffer.length > 0) {
    logicalLines.push(buffer);
  }

  return logicalLines;
}

function parsePythonImportedNames(rawList: string): string[] {
  const cleaned = rawList.replace(/[()]/g, '');
  const names: string[] = [];
  for (const part of cleaned.split(',')) {
    const trimmed = part.trim();
    if (trimmed.length === 0 || trimmed === '*') {
      continue;
    }
    const nameMatch = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(trimmed);
    if (nameMatch?.[1]) {
      names.push(nameMatch[1]);
    }
  }
  return names;
}

export function extractPythonImports(source: string): PythonImportSpec[] {
  const logicalLines = collectPythonLogicalLines(source);
  const specs: PythonImportSpec[] = [];

  for (const line of logicalLines) {
    const relFromMatch = /^from\s+(\.+)([A-Za-z0-9_.]*)\s+import\s+(.+)$/.exec(line);
    if (relFromMatch?.[1] && relFromMatch[3]) {
      specs.push({
        kind: 'from',
        dots: relFromMatch[1].length,
        module: relFromMatch[2] ?? '',
        names: parsePythonImportedNames(relFromMatch[3]),
      });
      continue;
    }

    const absFromMatch = /^from\s+([A-Za-z_][A-Za-z0-9_.]*)\s+import\s+(.+)$/.exec(line);
    if (absFromMatch?.[1] && absFromMatch[2]) {
      specs.push({
        kind: 'from',
        dots: 0,
        module: absFromMatch[1],
        names: parsePythonImportedNames(absFromMatch[2]),
      });
      continue;
    }

    const importMatch = /^import\s+(.+)$/.exec(line);
    if (importMatch?.[1]) {
      for (const part of importMatch[1].split(',')) {
        const modMatch = /^([A-Za-z_][A-Za-z0-9_.]*)/.exec(part.trim());
        if (modMatch?.[1]) {
          specs.push({
            kind: 'import',
            dots: 0,
            module: modMatch[1],
            names: [],
          });
        }
      }
    }
  }

  return specs;
}

function resolvePythonModuleCandidates(
  baseDir: string,
  moduleSegments: readonly string[],
  fileSet: ReadonlySet<string>,
): string[] {
  if (moduleSegments.length === 0) {
    return [];
  }
  const relBase =
    baseDir.length > 0
      ? posix.join(baseDir, ...moduleSegments)
      : posix.join(...moduleSegments);

  if (relBase === '..' || relBase.startsWith('../')) {
    return [];
  }

  const matches: string[] = [];
  const pyFile = `${relBase}.py`;
  if (fileSet.has(pyFile)) {
    matches.push(pyFile);
  }
  const initFile = `${relBase}/__init__.py`;
  if (fileSet.has(initFile)) {
    matches.push(initFile);
  }
  return matches;
}

export function resolvePythonImport(
  fromFile: string,
  spec: PythonImportSpec,
  fileSet: ReadonlySet<string>,
): string[] {
  const resolved = new Set<string>();
  const addMatches = (items: readonly string[]): void => {
    for (const item of items) {
      resolved.add(item);
    }
  };

  if (spec.dots > 0) {
    const dir = posix.dirname(fromFile);
    const dirParts = dir === '.' ? [] : dir.split('/');
    const upSteps = spec.dots - 1;
    if (upSteps > dirParts.length) {
      return [];
    }
    const baseDir = dirParts.slice(0, dirParts.length - upSteps).join('/');
    const modSegments = spec.module.length > 0 ? spec.module.split('.') : [];

    if (modSegments.length > 0) {
      addMatches(resolvePythonModuleCandidates(baseDir, modSegments, fileSet));
      for (const name of spec.names) {
        addMatches(resolvePythonModuleCandidates(baseDir, [...modSegments, name], fileSet));
      }
    } else {
      for (const name of spec.names) {
        addMatches(resolvePythonModuleCandidates(baseDir, [name], fileSet));
      }
    }

    return Array.from(resolved);
  }

  const modSegments = spec.module.split('.').filter((seg) => seg.length > 0);
  if (modSegments.length === 0) {
    return [];
  }

  const fromDir = posix.dirname(fromFile);
  const searchRoots: string[] = [...PYTHON_SOURCE_ROOTS];
  if (fromDir !== '.' && !searchRoots.includes(fromDir)) {
    searchRoots.push(fromDir);
  }

  for (const root of searchRoots) {
    const direct = resolvePythonModuleCandidates(root, modSegments, fileSet);
    addMatches(direct);

    if (spec.kind === 'from') {
      for (const name of spec.names) {
        addMatches(resolvePythonModuleCandidates(root, [...modSegments, name], fileSet));
      }
    }

    if (resolved.size > 0) {
      break;
    }
  }

  return Array.from(resolved);
}

export function findAffectedTestsAndNeighbors(
  cwd: string,
  changedFiles: readonly string[],
): ImportGraphResult {
  const repoFiles = walkRepoCodeFiles(cwd);
  const fileSet = new Set<string>(repoFiles);
  const contentCache = new Map<string, string>();

  const forwardGraph = new Map<string, Set<string>>();
  const reverseGraph = new Map<string, Set<string>>();

  const addEdge = (importer: string, target: string): void => {
    if (importer === target) {
      return;
    }
    let forward = forwardGraph.get(importer);
    if (!forward) {
      forward = new Set<string>();
      forwardGraph.set(importer, forward);
    }
    forward.add(target);

    let reverse = reverseGraph.get(target);
    if (!reverse) {
      reverse = new Set<string>();
      reverseGraph.set(target, reverse);
    }
    reverse.add(importer);
  };

  for (const relPath of repoFiles) {
    const content = readFileContentSafe(cwd, relPath);
    if (content === null) {
      continue;
    }
    contentCache.set(relPath, content);

    const ext = getFileExtension(relPath);
    if (ext === '.py') {
      const specs = extractPythonImports(content);
      for (const spec of specs) {
        for (const target of resolvePythonImport(relPath, spec, fileSet)) {
          addEdge(relPath, target);
        }
      }
    } else if (JS_TS_EXTENSION_SET.has(ext)) {
      const specifiers = extractJsTsImports(content);
      for (const specifier of specifiers) {
        const target = resolveJsTsImport(relPath, specifier, fileSet);
        if (target !== null) {
          addEdge(relPath, target);
        }
      }
    }
  }

  const normalizedChanged = Array.from(
    new Set(
      changedFiles
        .map((file) => normalizeRepoPath(file))
        .filter((file) => file.length > 0),
    ),
  );
  const changedSet = new Set<string>(normalizedChanged);

  const affectedTestPaths: string[] = [];
  const affectedTestSet = new Set<string>();
  const visited = new Set<string>();
  const queue: string[] = [];

  for (const file of normalizedChanged) {
    visited.add(file);
    queue.push(file);
    if (isTestFile(file) && !affectedTestSet.has(file)) {
      affectedTestSet.add(file);
      affectedTestPaths.push(file);
    }
  }

  let head = 0;
  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    if (current === undefined) {
      continue;
    }

    const importers = reverseGraph.get(current);
    if (!importers) {
      continue;
    }

    const sortedImporters = Array.from(importers).sort((a, b) => a.localeCompare(b));
    for (const importer of sortedImporters) {
      if (visited.has(importer)) {
        continue;
      }
      visited.add(importer);
      queue.push(importer);

      if (isTestFile(importer) && !affectedTestSet.has(importer)) {
        affectedTestSet.add(importer);
        affectedTestPaths.push(importer);
      }
    }
  }

  const neighborPathSet = new Set<string>();
  for (const changed of normalizedChanged) {
    const importers = reverseGraph.get(changed);
    if (importers) {
      for (const importer of importers) {
        if (
          !changedSet.has(importer) &&
          !affectedTestSet.has(importer) &&
          !isTestFile(importer)
        ) {
          neighborPathSet.add(importer);
        }
      }
    }

    const importees = forwardGraph.get(changed);
    if (importees) {
      for (const importee of importees) {
        if (
          !changedSet.has(importee) &&
          !affectedTestSet.has(importee) &&
          !isTestFile(importee)
        ) {
          neighborPathSet.add(importee);
        }
      }
    }
  }

  const neighborPaths = Array.from(neighborPathSet).sort((a, b) => a.localeCompare(b));

  const toSnippet = (relPath: string): FileSnippet | null => {
    const cached = contentCache.get(relPath);
    const content = cached ?? readFileContentSafe(cwd, relPath);
    if (content === null) {
      return null;
    }
    return { path: relPath, content };
  };

  const affectedTests: FileSnippet[] = [];
  for (const testPath of affectedTestPaths) {
    const snippet = toSnippet(testPath);
    if (snippet !== null) {
      affectedTests.push(snippet);
    }
  }

  const neighborContents: FileSnippet[] = [];
  for (const neighborPath of neighborPaths) {
    const snippet = toSnippet(neighborPath);
    if (snippet !== null) {
      neighborContents.push(snippet);
    }
  }

  return {
    affectedTests,
    neighborContents,
  };
}
