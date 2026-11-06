// NGA Figma Bridge — wire contract (single owner).
// Server and CLI import this file. The plugin (plain JS) mirrors ERROR_CODES in plugin/core.js;
// keep both lists identical (cli `bun fb.ts selftest` checks the plugin reports the same set).

export const PROTOCOL_VERSION = 1;

export const ERROR_CODES = [
  "INVALID_INPUT", // args failed validation
  "UNKNOWN_COMMAND", // no handler registered under that name
  "NOT_FOUND", // node / page / variable id does not resolve
  "PAGE_PROTECTED", // write aimed at a protected page (default: Original_Design)
  "PLUGIN_OFFLINE", // no plugin connected to the server
  "TIMEOUT", // server stopped waiting; the plugin job may still be running (see /status)
  "EXEC_UNSUPPORTED", // plugin sandbox refuses eval / new Function
  "FONT_MISSING", // requested font family is not installed in Figma
  "UI_FAILED", // plugin UI task failed (html layout, fetch)
  "INTERNAL", // anything else (message carries the reason)
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export type WireError = { code: ErrorCode; message: string };
export type WireResult<T = unknown> = { ok: true; data: T } | { ok: false; error: WireError };

// client -> server (HTTP POST /rpc)
export type RpcRequest = { v?: number; cmd: string; args?: Record<string, unknown>; timeoutMs?: number };

// server <-> plugin (WebSocket /plugin)
export type ToPlugin =
  | { type: "rpc"; id: string; cmd: string; args: Record<string, unknown> }
  | { type: "config"; protectedPages: string[] }
  | { type: "handlers"; files: { name: string; src: string }[] };
export type FromPlugin =
  | { type: "hello"; version: string; protocol: number; evalSupported: boolean; page: string; errorCodes: string[] }
  | { type: "result"; id: string; result: WireResult }
  | { type: "progress"; id: string; done: number; total: number; label?: string }
  | { type: "handlersLoaded"; names: string[]; error?: string }
  | { type: "pong" };

export const HTTP_STATUS: Record<ErrorCode, number> = {
  INVALID_INPUT: 400, UNKNOWN_COMMAND: 400, NOT_FOUND: 404, PAGE_PROTECTED: 403, PLUGIN_OFFLINE: 503,
  TIMEOUT: 504, EXEC_UNSUPPORTED: 501, FONT_MISSING: 422, UI_FAILED: 500, INTERNAL: 500,
};

// CLI exit codes
export const EXIT_CODE: Record<ErrorCode, number> = {
  INVALID_INPUT: 2, UNKNOWN_COMMAND: 2, NOT_FOUND: 5, PAGE_PROTECTED: 4, PLUGIN_OFFLINE: 3,
  TIMEOUT: 3, EXEC_UNSUPPORTED: 6, FONT_MISSING: 7, UI_FAILED: 1, INTERNAL: 1,
};

export const isErrorCode = (x: unknown): x is ErrorCode => typeof x === "string" && (ERROR_CODES as readonly string[]).includes(x);
