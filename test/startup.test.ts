import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// The shipped entry point in a real process: the built JS, the real MCP SDK and the real open-rfc.
const run = (env: Record<string, string>) =>
  spawnSync(process.execPath, ['dist/index.js'], { encoding: 'utf8', input: '', timeout: 20_000, env: { PATH: process.env.PATH ?? '', ...env } });

describe('entry point', () => {
  it('exits without touching the network while RFC access is off', () => {
    const result = run({ SAP_RFC_ASHOST: 'ecc.example.test', SAP_CLIENT: '100', SAP_USER: 'U', SAP_PASSWORD: 'never-printed' });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('"code":"disabled"');
    expect(result.stderr).not.toContain('never-printed');
  });

  it('starts when enabled and keeps stdout for the protocol', () => {
    const result = run({ RFC_MCP_ENABLED: 'true', SAP_RFC_ASHOST: 'ecc.example.test', SAP_CLIENT: '100', SAP_USER: 'U', SAP_PASSWORD: 'never-printed' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('"outcome":"started"');
    expect(result.stderr).not.toContain('never-printed');
  });

  it('resolves the SDK-free client without a native addon', async () => {
    const { Client } = await import('open-rfc');
    expect(typeof Client).toBe('function');
    expect(Client.environment.noderfc.implementation).toBe('open-rfc-sdk-free');
  });
});
