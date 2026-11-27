#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PolicyError, loadPolicy } from './policy.js';
import { openRfcConnect } from './rfc.js';
import { buildServer } from './server.js';

// stdout carries the MCP protocol, so every diagnostic goes to stderr. Events name the tool, the
// function module, the outcome and the duration; never parameters, rows or credentials.
const log = (event: Record<string, unknown>) => process.stderr.write(`${JSON.stringify({ source: 'rfc-mcp', ...event })}\n`);

try {
  // Optional: read the connection from a local env file so the password stays out of the MCP host's
  // configuration. Variables already set in the environment win over the file.
  const envFile = process.env.RFC_MCP_ENV_FILE;
  if (envFile) {
    try {
      process.loadEnvFile(envFile);
    } catch {
      throw new PolicyError('invalid_config', 'RFC_MCP_ENV_FILE could not be read.');
    }
  }
  const policy = loadPolicy(process.env);
  await buildServer({ policy, connect: openRfcConnect(policy), log }).connect(new StdioServerTransport());
  log({ outcome: 'started', extendedFunctions: policy.extendedFunctions.size, tableList: policy.tables !== null });
} catch (error) {
  if (!(error instanceof PolicyError)) throw error;
  log({ outcome: 'not_started', code: error.code, message: error.message });
  process.exitCode = 1;
}
