import { describe, it, expect, vi, beforeEach } from 'vitest';
import { attachElectronBridge, type IpcMessage, type IpcPort } from './electronBridge.js';

interface FakePort {
  postMessage: ReturnType<typeof vi.fn>;
  on: (event: string, cb: (msg: unknown) => void) => void;
  fire: (msg: IpcMessage) => void;
}

function makeFakePort(): FakePort {
  let listener: ((msg: unknown) => void) | undefined;
  return {
    postMessage: vi.fn(),
    on: (_event, cb) => {
      listener = cb;
    },
    fire: (msg) => listener?.(msg),
  };
}

describe('electronBridge', () => {
  describe('no-op mode (no parentPort)', () => {
    let bridge: ReturnType<typeof attachElectronBridge>;
    beforeEach(() => {
      bridge = attachElectronBridge(undefined);
    });

    it('emitters do nothing and do not throw', () => {
      expect(() => bridge.emitReady(7423)).not.toThrow();
      expect(() => bridge.emitLog('info', 'hello')).not.toThrow();
      expect(() => bridge.emitState('idle')).not.toThrow();
    });

    it('subscribers are never invoked', () => {
      const cb = vi.fn();
      bridge.onShutdown(cb);
      bridge.onPauseToggle(cb);
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('connected mode (parentPort present)', () => {
    it('emitReady posts a ready message', () => {
      const port = makeFakePort();
      const bridge = attachElectronBridge(port as IpcPort);
      bridge.emitReady(7423);
      expect(port.postMessage).toHaveBeenCalledWith({ type: 'ready', port: 7423 });
    });

    it('emitLog posts log messages with level and text', () => {
      const port = makeFakePort();
      const bridge = attachElectronBridge(port as IpcPort);
      bridge.emitLog('warn', 'careful now');
      expect(port.postMessage).toHaveBeenCalledWith({ type: 'log', level: 'warn', text: 'careful now' });
    });

    it('emitState posts state with optional reason', () => {
      const port = makeFakePort();
      const bridge = attachElectronBridge(port as IpcPort);
      bridge.emitState('cycling');
      bridge.emitState('error', 'captcha unsolved');
      expect(port.postMessage).toHaveBeenNthCalledWith(1, { type: 'state', status: 'cycling' });
      expect(port.postMessage).toHaveBeenNthCalledWith(2, { type: 'state', status: 'error', reason: 'captcha unsolved' });
    });

    it('onShutdown invokes callback when shutdown arrives', () => {
      const port = makeFakePort();
      const bridge = attachElectronBridge(port as IpcPort);
      const cb = vi.fn();
      bridge.onShutdown(cb);
      port.fire({ type: 'shutdown' });
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('onPauseToggle invokes callback with paused flag', () => {
      const port = makeFakePort();
      const bridge = attachElectronBridge(port as IpcPort);
      const cb = vi.fn();
      bridge.onPauseToggle(cb);
      port.fire({ type: 'pauseToggle', paused: true });
      expect(cb).toHaveBeenCalledWith(true);
    });

    it('ignores unknown message types silently', () => {
      const port = makeFakePort();
      const bridge = attachElectronBridge(port as IpcPort);
      const cb = vi.fn();
      bridge.onShutdown(cb);
      port.fire({ type: 'unknown' } as unknown as IpcMessage);
      expect(cb).not.toHaveBeenCalled();
    });
  });
});
