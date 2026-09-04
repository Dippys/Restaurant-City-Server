import type { RpcSummary } from '../types';
import { parseRequest, writeU8, writeVarint } from './codec';
import { CALL_TYPES } from './calls';
import { responders } from './responders';
import type { ActiveAccount } from '../session';

export { CALL_TYPES };

export interface RpcBuildResult {
  readonly response: Buffer;
  readonly summary: RpcSummary;
}

export async function buildResponse(buf: Buffer, account: ActiveAccount): Promise<RpcBuildResult> {
  const req = parseRequest(buf);
  const summary: RpcSummary = { call: req.name, subs: [] };

  if (req.error) {
    summary.error = req.error;
    return { response: Buffer.from([0, 0, 0]), summary };
  }

  if (req.msgType === 255 && req.subs) {
    const parts: Buffer[] = [writeU8(0), writeU8(255), writeVarint(req.subs.length)];

    for (const sub of req.subs) {
      const responder = responders[sub.msgType];
      const body = responder ? await responder({ ...sub, session: req.session }, account) : null;

      if (body !== null) {
        parts.push(writeU8(sub.msgType), writeVarint(body.length), body);
        summary.subs?.push({ name: sub.name, answered: 'ok' });
      } else {
        parts.push(writeU8(0), writeVarint(0));
        summary.subs?.push({ name: sub.name, answered: 'ERROR (not implemented)' });
      }
    }

    return { response: Buffer.concat(parts), summary };
  }

  const responder = req.msgType === undefined ? undefined : responders[req.msgType];
  const body = responder ? await responder(req, account) : null;

  if (req.msgType !== undefined && body !== null) {
    summary.answered = 'ok';
    return { response: Buffer.concat([writeU8(0), writeU8(req.msgType), body]), summary };
  }

  summary.answered = 'ERROR (not implemented)';
  return { response: Buffer.from([0, 0, 0]), summary };
}
