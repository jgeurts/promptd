import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { RequestHandler, Response } from 'express';
import { BINARY_VERSION } from './binary.js';

const BUILD_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(BUILD_DIR, '..', 'public');

// A binary carries the page's files inside it, so an update is one file to swap;
// a checkout serves them from public/.
const embedded: Record<string, string> | null = BINARY_VERSION ? (await import('promptd:public')).default : null;

/** Serves the page's static files. */
export function servePublic(): RequestHandler {
  if (!embedded) return express.static(PUBLIC_DIR);
  const files = embedded;
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const name = req.path === '/' ? 'index.html' : req.path.slice(1);
    // Own keys only, so a path such as /constructor is a 404 rather than Object's.
    if (!Object.hasOwn(files, name)) return next();
    res.type(path.extname(name)).send(files[name]);
  };
}

/** Sends one of the page's files, by its name in public/. */
export function sendPublicFile(res: Response, name: string): void {
  if (embedded) res.type(path.extname(name)).send(embedded[name]);
  else res.sendFile(path.join(PUBLIC_DIR, name));
}

/**
 * Sends a module the page shares with the hub, by its name in src/: compiled
 * into dist/ beside this file in a checkout, embedded as shared/<name>.js in a binary.
 */
export function sendSharedModule(res: Response, name: string): void {
  if (embedded) res.type('.js').send(embedded[`shared/${name}.js`]);
  else res.sendFile(path.join(BUILD_DIR, `${name}.js`));
}
