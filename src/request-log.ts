import type { ServerResponse } from 'node:http';
import type { CapturedRequest } from './types';

export class RequestLog {
  private readonly entries: CapturedRequest[] = [];
  private readonly clients = new Set<ServerResponse>();
  private seq = 0;

  constructor(private readonly maxEntries: number) {}

  nextId(): number {
    this.seq += 1;
    return this.seq;
  }

  snapshot(): readonly CapturedRequest[] {
    return this.entries;
  }

  clear(): void {
    this.entries.length = 0;
  }

  addSseClient(res: ServerResponse): void {
    this.clients.add(res);
    for (const entry of this.entries) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }
  }

  removeSseClient(res: ServerResponse): void {
    this.clients.delete(res);
  }

  record(entry: CapturedRequest): void {
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }

    const payload = `data: ${JSON.stringify(entry)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(payload);
      } catch {
        this.clients.delete(res);
      }
    }

    const bodyNote = entry.bodyLen ? ` body=${entry.bodyLen}B` : '';
    const matchNote = entry.matched ? ` -> ${entry.matched}` : '';
    const userNote = entry.account ? ` (${entry.account.username})` : '';
    console.log(`[${entry.status}] ${entry.method} ${entry.path}${bodyNote}${matchNote}${userNote}`);

    if (entry.kind === 'rpc' && entry.rpc) {
      if (entry.rpc.subs?.length) {
        const subs = entry.rpc.subs
          .map((sub) => `${sub.name}${sub.answered === 'ok' ? '' : '=ERR'}`)
          .join(', ');
        console.log(`      batch(${entry.rpc.subs.length}): ${subs}`);
      } else {
        console.log(`      call: ${entry.rpc.call} -> ${entry.rpc.answered || entry.rpc.error || ''}`);
      }
    }
  }
}
