export interface IpcPort {
  on(event: 'message', cb: (msg: unknown) => void): void;
  postMessage(msg: unknown): void;
}

export type IpcMessage =
  | { type: 'ready'; port: number }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'state'; status: 'idle' | 'cycling' | 'paused' | 'error'; reason?: string }
  | { type: 'shutdown' }
  | { type: 'pauseToggle'; paused: boolean };

export interface ElectronBridge {
  emitReady(port: number): void;
  emitLog(level: 'info' | 'warn' | 'error', text: string): void;
  emitState(status: 'idle' | 'cycling' | 'paused' | 'error', reason?: string): void;
  onShutdown(cb: () => void): void;
  onPauseToggle(cb: (paused: boolean) => void): void;
}

/**
 * Returns a bridge. In CLI mode `port` is undefined and every method
 * is a no-op. In Electron utility-process mode `port` is `process.parentPort`.
 */
export function attachElectronBridge(port: IpcPort | undefined): ElectronBridge {
  if (!port) {
    return {
      emitReady: () => {},
      emitLog: () => {},
      emitState: () => {},
      onShutdown: () => {},
      onPauseToggle: () => {},
    };
  }

  const shutdownCbs: Array<() => void> = [];
  const pauseCbs: Array<(paused: boolean) => void> = [];

  port.on('message', (raw: unknown) => {
    const msg = raw as IpcMessage;
    switch (msg?.type) {
      case 'shutdown':
        for (const cb of shutdownCbs) cb();
        break;
      case 'pauseToggle':
        for (const cb of pauseCbs) cb(msg.paused);
        break;
      default:
        // Ignore unknown types silently.
        break;
    }
  });

  const post = (msg: IpcMessage) => port.postMessage(msg);

  return {
    emitReady: (uiPort) => post({ type: 'ready', port: uiPort }),
    emitLog: (level, text) => post({ type: 'log', level, text }),
    emitState: (status, reason) =>
      reason === undefined
        ? post({ type: 'state', status })
        : post({ type: 'state', status, reason }),
    onShutdown: (cb) => shutdownCbs.push(cb),
    onPauseToggle: (cb) => pauseCbs.push(cb),
  };
}
