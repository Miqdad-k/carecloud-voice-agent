import { afterEach, describe, expect, it, vi } from 'vitest';
import { startKeepAwake } from '../src/keep-awake.js';

const log = { error: vi.fn() };

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('keep-awake', () => {
  it('does nothing without a Render URL, so local runs and tests make no requests', () => {
    const request = vi.fn();
    expect(startKeepAwake(undefined, log, request as unknown as typeof fetch)).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it('requests /health well inside the 15 minute idle limit', () => {
    vi.useFakeTimers();
    const request = vi.fn().mockResolvedValue(new Response());
    const timer = startKeepAwake('https://example.onrender.com', log, request as unknown as typeof fetch);

    vi.advanceTimersByTime(14 * 60 * 1000);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('https://example.onrender.com/health');
    clearInterval(timer!);
  });

  it('logs a failed request instead of crashing the app', async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockRejectedValue(new Error('network down'));
    const timer = startKeepAwake('https://example.onrender.com', log, request as unknown as typeof fetch);

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(log.error).toHaveBeenCalledOnce();
    clearInterval(timer!);
  });
});
