// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { logger } from './utils/logger.js';

interface CompileCommand {
  file: string;
  directory: string;
  command?: string;
  arguments?: string[];
}

/** Default paths to exclude from indexing */
const DEFAULT_EXCLUDE_PATHS = [
  '_deps/',
  'third_party/',
  'libs/',
  'vendor/',
  'external/',
  'build/',
];

/**
 * Find compile_commands.json in common locations
 */
function findCompileCommands(projectRoot: string): string | undefined {
  const candidates = [
    'compile_commands.json',  // Project root (symlinked)
    'build/compile_commands.json',
    'cmake-build-debug/compile_commands.json',
    'cmake-build-release/compile_commands.json',
    'out/build/compile_commands.json',
    '.build/compile_commands.json',
  ];

  for (const candidate of candidates) {
    const path = join(projectRoot, candidate);
    if (existsSync(path)) {
      return path;
    }
  }

  return undefined;
}

/**
 * Detect source files from compile_commands.json
 * Returns absolute paths to source files
 * @param projectRoot - The project root directory
 * @param excludePaths - Additional paths to exclude (merged with defaults)
 */
export async function detectCMakeSources(
  projectRoot: string,
  excludePaths: string[] = []
): Promise<string[]> {
  const allExcludes = [...DEFAULT_EXCLUDE_PATHS, ...excludePaths];

  const compileCommandsPath = findCompileCommands(projectRoot);
  if (!compileCommandsPath) {
    logger.info('No compile_commands.json found. Ensure CMAKE_EXPORT_COMPILE_COMMANDS=ON');
    return [];
  }

  logger.info('Found compile_commands.json at:', compileCommandsPath);

  try {
    const content = await readFile(compileCommandsPath, 'utf-8');
    const commands: CompileCommand[] = JSON.parse(content);

    const sources: Set<string> = new Set();

    for (const cmd of commands) {
      // Resolve absolute path
      const filePath = cmd.file.startsWith('/')
        ? cmd.file
        : resolve(cmd.directory, cmd.file);

      // Skip files outside project root
      if (!filePath.startsWith(projectRoot)) {
        continue;
      }

      // Skip excluded paths
      const relativePath = filePath.slice(projectRoot.length + 1);
      if (allExcludes.some(exc => relativePath.startsWith(exc) || relativePath.includes('/' + exc))) {
        continue;
      }

      // Only include source files (not headers - clangd indexes those via includes)
      if (/\.(c|cc|cpp|cxx|c\+\+|m|mm)$/i.test(filePath)) {
        sources.add(filePath);
      }
    }

    const result = Array.from(sources);
    logger.info(`Found ${result.length} source files from compile_commands.json`);
    return result;

  } catch (error) {
    logger.error('Failed to read compile_commands.json:', error);
    return [];
  }
}

/**
 * Get a representative sample of source files for warming
 * Tries to get files from different directories for better coverage
 */
export function selectWarmingFiles(sources: string[], maxFiles: number = 5): string[] {
  if (sources.length <= maxFiles) {
    return sources;
  }

  // Group files by directory
  const byDir: Map<string, string[]> = new Map();
  for (const source of sources) {
    const dir = dirname(source);
    if (!byDir.has(dir)) {
      byDir.set(dir, []);
    }
    byDir.get(dir)!.push(source);
  }

  // Select files from different directories
  const selected: string[] = [];
  const dirs = Array.from(byDir.keys()).sort();

  let dirIndex = 0;
  while (selected.length < maxFiles && dirIndex < dirs.length) {
    const dir = dirs[dirIndex];
    const files = byDir.get(dir)!;
    if (files.length > 0) {
      selected.push(files.shift()!);
    }
    dirIndex++;

    // Wrap around if we still need more files
    if (dirIndex >= dirs.length && selected.length < maxFiles) {
      dirIndex = 0;
      // Remove empty directories
      for (const [d, f] of byDir.entries()) {
        if (f.length === 0) byDir.delete(d);
      }
      if (byDir.size === 0) break;
    }
  }

  return selected;
}
