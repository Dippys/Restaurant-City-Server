import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ServerConfig } from './config';

const MIME: Record<string, string> = {
  '.swf': 'application/x-shockwave-flash',
  '.xml': 'application/xml',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export interface StaticMatch {
  readonly fullPath: string;
  readonly displayPath: string;
  readonly mimeType: string;
}

export function normaliseAssetName(name: string): string {
  return path.basename(name).toLowerCase().replace(/\[\d+\]/g, '');
}

export class StaticFileIndex {
  private files = new Map<string, string>();

  constructor(private readonly config: ServerConfig) {
    this.reindex();
  }

  get size(): number {
    return this.files.size;
  }

  servesRebuiltGameSwf(): boolean {
    return this.files.get('game.swf') === this.config.rebuiltSwf;
  }

  reindex(): void {
    const next = new Map<string, string>();
    this.addDirectory(next, this.config.rcRoot);
    this.addDirectory(next, this.config.binXmlRoot);
    this.addOriginalAssetSwfs(next, this.config.originalAssetRoot);
    this.addRebuiltAssetSwfs(next, this.config.rebuiltAssetRoot);

    if (fs.existsSync(this.config.rebuiltSwf)) {
      next.set('game.swf', this.config.rebuiltSwf);
    }

    this.files = next;
  }

  find(requestPath: string): StaticMatch | null {
    const fullPath = this.files.get(normaliseAssetName(requestPath));
    if (!fullPath) {
      return null;
    }

    return {
      fullPath,
      displayPath: path.relative(this.config.rcRoot, fullPath),
      mimeType: MIME[path.extname(fullPath).toLowerCase()] || 'application/octet-stream',
    };
  }

  private addDirectory(target: Map<string, string>, dir: string): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      try {
        if (fs.statSync(fullPath).isFile()) {
          target.set(normaliseAssetName(fullPath), fullPath);
        }
      } catch {
        // Ignore files that disappear during reindex.
      }
    }
  }

  private addOriginalAssetSwfs(target: Map<string, string>, dir: string): void {
    this.addSwfs(target, dir, false);
  }

  private addRebuiltAssetSwfs(target: Map<string, string>, dir: string): void {
    this.addSwfs(target, dir, true);
  }

  private addSwfs(target: Map<string, string>, dir: string, includeGameSwf: boolean): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      try {
        if ((includeGameSwf || entry.toLowerCase() !== 'game.swf') && path.extname(entry).toLowerCase() === '.swf' && fs.statSync(fullPath).isFile()) {
          target.set(normaliseAssetName(entry), fullPath);
        }
      } catch {
        // Ignore files that disappear during reindex.
      }
    }
  }
}
