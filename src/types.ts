import type { IncomingHttpHeaders } from 'node:http';

export type RequestKind = 'http' | 'rpc';

export interface AccountStamp {
  readonly username: string;
  readonly networkUid: string;
}

export interface RpcSubSummary {
  readonly name: string;
  readonly answered: string;
}

export interface RpcSummary {
  readonly call: string;
  readonly subs?: RpcSubSummary[];
  answered?: string;
  error?: string;
}

export interface CapturedRequest {
  id: number;
  time: string;
  method?: string;
  path: string;
  rawUrl?: string;
  query?: Record<string, string>;
  headers?: IncomingHttpHeaders;
  bodyLen: number;
  bodyHex?: string;
  bodyBase64?: string;
  bodyText?: string;
  kind: RequestKind;
  matched: string | null;
  status: number;
  respLen?: number;
  respHex?: string;
  durationMs: number;
  rpc?: RpcSummary;
  /** Authenticated player behind this request (admin dashboard display). */
  account?: AccountStamp | null;
}
