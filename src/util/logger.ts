/**
 * Tiny structured-logger interface. Wraps `console.{log,warn,error}` with
 * level filtering + an optional tag prefix. Designed so a future swap to
 * `pino` or `winston` is a one-line constructor change — the rest of the
 * codebase consumes the {@link Logger} interface, not the implementation.
 *
 * Why a custom interface instead of pulling pino now: adding a new dependency
 * to a deterministic browser-driving bot has more risk than upside today; the
 * file-logging tee in `appInit.ts` already covers persistence. When the time
 * comes to ship JSON logs to a sink, replace `createConsoleLogger` with
 * `createPinoLogger` and the call sites are unchanged.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(message: string, ...rest: unknown[]): void;
  info(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
  error(message: string, ...rest: unknown[]): void;
  /** Returns a child logger with `tag` appended to the parent's tag chain. */
  child(tag: string): Logger;
}

export interface LoggerOptions {
  /** Messages below this level are silently dropped. Default: `debug`. */
  minLevel?: LogLevel;
  /** Optional prefix (no brackets) — emitted as `[tag]` on every line. */
  tag?: string;
}

export function createConsoleLogger(options: LoggerOptions = {}): Logger {
  const minPriority = LEVEL_PRIORITY[options.minLevel ?? 'debug'];
  const tagPart = options.tag ? `[${options.tag}] ` : '';

  function format(level: LogLevel, message: string): string {
    return `${tagPart}[${level}] ${message}`;
  }

  function emit(level: LogLevel, message: string, rest: unknown[]): void {
    if (LEVEL_PRIORITY[level] < minPriority) return;
    const line = format(level, message);
    if (level === 'error') console.error(line, ...rest);
    else if (level === 'warn') console.warn(line, ...rest);
    else console.log(line, ...rest);
  }

  return {
    debug: (msg, ...rest) => emit('debug', msg, rest),
    info: (msg, ...rest) => emit('info', msg, rest),
    warn: (msg, ...rest) => emit('warn', msg, rest),
    error: (msg, ...rest) => emit('error', msg, rest),
    child: (subTag: string) =>
      createConsoleLogger({
        minLevel: options.minLevel,
        tag: options.tag ? `${options.tag}:${subTag}` : subTag,
      }),
  };
}

/**
 * Shared root logger for the agent. Pre-tagged callers (`runner`, `cycle`, …)
 * should call `.child('foo')` on this rather than importing `console` directly.
 */
export const rootLogger: Logger = createConsoleLogger();
