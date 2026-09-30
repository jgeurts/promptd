import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { RequestHandler, Response } from 'express';
import { BINARY_VERSION } from './binary.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

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
    const body = files[name];
    if (body === undefined) return next();
    res.type(path.extname(name)).send(body);
  };
}

/** Sends one of the page's files, by its name in public/. */
export function sendPublicFile(res: Response, name: string): void {
  if (embedded) res.type(path.extname(name)).send(embedded[name]);
  else res.sendFile(path.join(PUBLIC_DIR, name));
}
