import { describe, it, expect } from 'vitest';
import { createStopController } from './stopController.js';

describe('stopController', () => {
  it('starts in running state', () => {
    const ctrl = createStopController();
    expect(ctrl.isStopping()).toBe(false);
  });

  it('flips to stopping on first request', () => {
    const ctrl = createStopController();
    ctrl.requestStop();
    expect(ctrl.isStopping()).toBe(true);
  });

  it('returns true from requestStop only on the first call', () => {
    const ctrl = createStopController();
    expect(ctrl.requestStop()).toBe(true);
    expect(ctrl.requestStop()).toBe(false);
  });
});
