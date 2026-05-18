export interface StopController {
  isStopping(): boolean;
  /** Returns true on the first call, false on every subsequent call. */
  requestStop(): boolean;
}

export function createStopController(): StopController {
  let stopping = false;
  return {
    isStopping: () => stopping,
    requestStop: () => {
      if (stopping) return false;
      stopping = true;
      return true;
    },
  };
}
