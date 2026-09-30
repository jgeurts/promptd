import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveUserPath } from './paths.js';

export interface BrowseResult {
  suggestions: string[];
  resolved: string | null;
  exists: boolean;
  truncated: boolean;
}

/**
 * Directory suggestions for the Working Directory field.
 * Splits what the user typed into an already-typed parent and a partial name,
 * then lists the parent's subdirectories that start with that partial.
 */
export async function browseDirectories(typed: string): Promise<BrowseResult> {
  // Everything up to the last slash is settled; what follows is being typed.
  const cut = typed.lastIndexOf('/');
  const parentTyped = cut >= 0 ? typed.slice(0, cut + 1) : '~/';
  const partial = cut >= 0 ? typed.slice(cut + 1) : typed;
  const parentPath = resolveUserPath(parentTyped) ?? os.homedir();

  const entries = await fsp.readdir(parentPath, { withFileTypes: true }).catch(() => []);
  const wanted = partial.toLowerCase();
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.name.toLowerCase().startsWith(wanted)) continue;
    if (entry.name.startsWith('.') && !partial.startsWith('.')) continue;
    if (entry.isDirectory()) names.push(entry.name);
    else if (entry.isSymbolicLink()) {
      const isDir = await fsp
        .stat(path.join(parentPath, entry.name))
        .then((s) => s.isDirectory())
        .catch(() => false);
      if (isDir) names.push(entry.name);
    }
    if (names.length >= 200) break;
  }
  names.sort((a, b) => a.localeCompare(b));

  // Suggestions come back in the same style the user is typing, tilde included.
  const suggestions = names.slice(0, 25).map((name) => `${parentTyped}${name}/`);
  const resolved = resolveUserPath(typed);
  const exists = resolved
    ? await fsp
        .stat(resolved)
        .then((s) => s.isDirectory())
        .catch(() => false)
    : false;
  return { suggestions, resolved, exists, truncated: names.length > 25 };
}
