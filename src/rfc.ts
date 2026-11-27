import type { Policy } from './policy.js';

export type RfcParameters = Readonly<Record<string, unknown>>;

/** One logon. Tools open a session per call, so an uncommitted change never outlives its call. */
export interface RfcSession {
  call(functionName: string, parameters: RfcParameters): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export type Connect = () => Promise<RfcSession>;

/** Sessions over classic RFC to the application server gateway (33NN), without the SAP NW RFC SDK. */
export function openRfcConnect(policy: Policy): Connect {
  return async () => {
    const { Client } = await import('open-rfc');
    const client = new Client({ ...policy.connection }, { timeout: policy.timeoutSeconds });
    await client.open();
    return {
      call: async (functionName, parameters) => ({ ...(await client.call(functionName, parameters)) }),
      close: async () => {
        await client.close();
      },
    };
  };
}

export type Blocker = 'absent' | 'ucon' | 'gateway_acl' | 'table_auth' | 'rfc_auth' | 'row_512' | 'logon' | 'unreachable' | 'other';

export interface ClassifiedError {
  blocker: Blocker;
  key: string | null;
  message: string;
}

const UCON = [/UCON/i, /not released for RFC/i, /RFC_UNIT/i];
const GATEWAY = [/reg_info/i, /sec_info/i, /gateway/i, /CALLBACK/i];
const TABLE_AUTH = [/TABLE_NOT_AVAILABLE/i, /NOT_AUTHORIZED/i, /S_TABU/i];
const RFC_AUTH = [/No RFC authorization/i, /S_RFC/i, /not authorized/i, /AUTHORIZATION/i];
const UNREACHABLE = [/NI_CONNECT/i, /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH/, /timed? ?out/i];
const LOGON = [/LOGON_FAILURE/i, /password/i, /user .* locked/i, /incorrect.*(name|client)/i];

/**
 * Says why SAP refused a call, because on a hardened ECC system the cause is what the operator has
 * to act on. `secrets` are removed from the message so a credential echoed by a peer never leaves.
 */
export function classifyError(error: unknown, secrets: readonly string[] = []): ClassifiedError {
  const source = (error ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const key = text(source.key) || null;
  let message = [text(source.message), text(source.key), text(source.rfcMessage)].filter(Boolean).join(' | ');
  for (const secret of secrets) if (secret) message = message.split(secret).join('[redacted]');
  const hit = (patterns: readonly RegExp[]) => patterns.some((pattern) => pattern.test(message));
  let blocker: Blocker = 'other';
  if (/FU_NOT_FOUND|does not exist/i.test(message)) blocker = 'absent';
  else if (hit(UNREACHABLE)) blocker = 'unreachable';
  else if (hit(UCON)) blocker = 'ucon';
  else if (hit(GATEWAY)) blocker = 'gateway_acl';
  else if (/DATA_BUFFER_EXCEEDED/i.test(message)) blocker = 'row_512';
  else if (hit(TABLE_AUTH)) blocker = 'table_auth';
  else if (hit(LOGON)) blocker = 'logon';
  else if (hit(RFC_AUTH)) blocker = 'rfc_auth';
  return { blocker, key, message: message.slice(0, 300) };
}
