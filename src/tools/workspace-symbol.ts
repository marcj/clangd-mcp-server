// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { LSPClient } from '../lsp-client.js';
import { uriToPath } from '../utils/uri.js';
import { withRetry } from '../utils/errors.js';
import { symbolKindNames } from '../utils/lsp-types.js';

interface SymbolInformation {
  name: string;
  kind: number;
  location: {
    uri: string;
    range: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
  };
  containerName?: string;
}

export interface WorkspaceSymbolOptions {
  query: string;
  limit?: number;
  /** Include symbols from outside the project root (default: false) */
  includeExternal?: boolean;
  /** Paths to exclude from results (e.g., ["libs/", "third_party/"]) */
  excludePaths?: string[];
}

export async function workspaceSymbolSearch(
  lspClient: LSPClient,
  projectRoot: string,
  options: WorkspaceSymbolOptions
): Promise<string> {
  const { query, limit = 100, includeExternal = false, excludePaths = [] } = options;

  // Make LSP request with retry
  const symbols: SymbolInformation[] = await withRetry(async () => {
    const result = await lspClient.request('workspace/symbol', {
      query
    });

    return result || [];
  });

  // Apply filtering
  let filteredSymbols = symbols;

  // Filter to project root unless includeExternal is true
  if (!includeExternal && projectRoot) {
    filteredSymbols = filteredSymbols.filter(sym => {
      const filePath = uriToPath(sym.location.uri);
      return filePath.startsWith(projectRoot);
    });
  }

  // Apply exclude paths
  if (excludePaths.length > 0) {
    filteredSymbols = filteredSymbols.filter(sym => {
      const filePath = uriToPath(sym.location.uri);
      // Check if any exclude path matches
      return !excludePaths.some(excludePath => {
        // Support both absolute and relative paths
        if (excludePath.startsWith('/')) {
          return filePath.startsWith(excludePath);
        } else {
          // Relative path - check if it's a component of the path under project root
          const relativePath = filePath.slice(projectRoot.length + 1);
          return relativePath.startsWith(excludePath) ||
                 relativePath.includes('/' + excludePath);
        }
      });
    });
  }

  // Format results
  if (filteredSymbols.length === 0) {
    const filterInfo = !includeExternal ? ` in project '${projectRoot}'` : '';
    const excludeInfo = excludePaths.length > 0 ? ` (excluding: ${excludePaths.join(', ')})` : '';
    return JSON.stringify({
      found: false,
      message: `No symbols found matching '${query}'${filterInfo}${excludeInfo}`
    });
  }

  // Apply limit
  const limitedSymbols = filteredSymbols.slice(0, limit);

  const formattedSymbols = limitedSymbols.map(sym => ({
    name: sym.name,
    kind: symbolKindNames[sym.kind] || `Unknown(${sym.kind})`,
    file: uriToPath(sym.location.uri),
    line: sym.location.range.start.line,
    column: sym.location.range.start.character,
    container: sym.containerName,
    uri: sym.location.uri
  }));

  return JSON.stringify({
    found: true,
    count: filteredSymbols.length,
    returned: formattedSymbols.length,
    truncated: filteredSymbols.length > limit,
    projectRoot,
    includeExternal,
    excludePaths: excludePaths.length > 0 ? excludePaths : undefined,
    symbols: formattedSymbols
  }, null, 2);
}
