/**
 * pino JSON lines to fd 2 (stderr). stdout belongs to the stdio MCP protocol -
 * a log line on fd 1 would corrupt the JSON-RPC stream. House convention shared
 * with every rzem MCP server.
 */

import pino from "pino";

export type Logger = pino.Logger;

export function createLogger(level: string): Logger {
  return pino({ level }, pino.destination(2));
}
