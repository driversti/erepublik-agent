import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createConsoleLogger, type Logger, type LogLevel } from './logger.js';

describe('createConsoleLogger', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('writes info to console.log with [info] tag', () => {
    const log = createConsoleLogger();
    log.info('hello');
    expect(logSpy).toHaveBeenCalledTimes(1);
    const arg = logSpy.mock.calls[0][0] as string;
    expect(arg).toMatch(/\[info\]/);
    expect(arg).toContain('hello');
  });

  it('writes warn to console.warn', () => {
    const log = createConsoleLogger();
    log.warn('oops');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/\[warn\].*oops/);
  });

  it('writes error to console.error', () => {
    const log = createConsoleLogger();
    log.error('boom');
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0][0]).toMatch(/\[error\].*boom/);
  });

  it('respects minLevel — debug is suppressed when minLevel=info', () => {
    const log = createConsoleLogger({ minLevel: 'info' });
    log.debug('verbose');
    log.info('shown');
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toContain('shown');
  });

  it('respects minLevel — warn suppresses info', () => {
    const log = createConsoleLogger({ minLevel: 'warn' });
    log.info('hidden');
    log.warn('shown');
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('passes through tag prefix when supplied', () => {
    const log = createConsoleLogger({ tag: 'cycle' });
    log.info('hi');
    expect(logSpy.mock.calls[0][0]).toMatch(/\[cycle\].*\[info\].*hi/);
  });

  it('child() inherits options but appends a sub-tag', () => {
    const root = createConsoleLogger({ tag: 'cycle' });
    const sub = root.child('farm');
    sub.info('there');
    expect(logSpy.mock.calls[0][0]).toMatch(/\[cycle:farm\].*\[info\].*there/);
  });

  it('all four levels (debug/info/warn/error) are callable', () => {
    const log: Logger = createConsoleLogger({ minLevel: 'debug' });
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    for (const lvl of levels) {
      log[lvl]('ok');
    }
    // debug + info go to console.log; warn → warn; error → error
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledTimes(1);
  });
});
