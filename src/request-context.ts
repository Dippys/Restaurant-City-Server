import type { IncomingMessage } from 'node:http';
import { impersonationFromRequest, type ImpersonationState } from './impersonation';
import { accountFromRequest, type ActiveAccount } from './session';

export type AccountResolver = (req: IncomingMessage) => Promise<ActiveAccount | null>;

/** Request-scoped authentication. Raw cookie/session tokens are never exposed. */
export class RequestContext {
  readonly requestId: number;
  readonly startedAt: number;
  readonly account: ActiveAccount | null;
  #request: IncomingMessage;
  #impersonation?: Promise<ImpersonationState>;

  constructor(requestId: number, request: IncomingMessage, account: ActiveAccount | null, startedAt = performance.now()) {
    this.requestId = requestId;
    this.#request = request;
    this.account = account;
    this.startedAt = startedAt;
  }

  impersonation(): Promise<ImpersonationState> {
    this.#impersonation ??= impersonationFromRequest(this.#request, this.account);
    return this.#impersonation;
  }

  async gameAccount(): Promise<ActiveAccount | null> {
    const impersonation = await this.impersonation();
    return impersonation.present ? impersonation.account : this.account;
  }
}

export async function resolveRequestContext(
  requestId: number,
  req: IncomingMessage,
  resolver: AccountResolver = accountFromRequest,
): Promise<RequestContext> {
  const startedAt = performance.now();
  return new RequestContext(requestId, req, await resolver(req), startedAt);
}
