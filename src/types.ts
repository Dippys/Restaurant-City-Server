import type { IncomingHttpHeaders } from 'node:http';

export type RequestKind = 'http' | 'rpc';

export interface RpcSubSummary {
  readonly name: string;
  readonly answered: string;
}

export interface RpcSummary {
  readonly call: string;
  readonly session?: string;
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
  query: Record<string, string>;
  headers: IncomingHttpHeaders;
  bodyLen: number;
  bodyHex: string;
  bodyBase64: string;
  bodyText: string;
  kind: RequestKind;
  matched: string | null;
  status: number;
  respLen?: number;
  respHex?: string;
  rpc?: RpcSummary;
}
