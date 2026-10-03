// @vitest-environment happy-dom
/**
 * The audit's A01 and A07, against the real synthesis host module.
 *
 * A01: the host is web-accessible, so any page can embed it and offer it a port. It must only
 * accept one that carries a ticket the background minted.
 * A07: after the host has reported readiness, a worker that dies must fail the sentence it was
 * holding and be replaced — it used to be ignored, stranding that sentence and the queue.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeWorkerLike {
  messages: unknown[];
  terminated: boolean;
  onmessage?: (e: { data: unknown }) => void;
  onerror?: (e: { message: string; preventDefault?: () => void }) => void;
  onmessageerror?: () => void;
}

const workers: FakeWorkerLike[] = [];

class FakeWorker implements FakeWorkerLike {
  messages: unknown[] = [];
  terminated = false;
  onmessage?: (e: { data: unknown }) => void;
  onerror?: (e: { message: string; preventDefault?: () => void }) => void;
  onmessageerror?: () => void;
  constructor() {
    workers.push(this);
  }
  postMessage(m: unknown): void {
    this.messages.push(m);
  }
  terminate(): void {
    this.terminated = true;
  }
}

/** The background: it approves only the ticket it minted. */
let validTicket: string | null = 'ticket-1';
const answer = (m: { type?: string; ticket?: string }) =>
  m.type === 'synth-ticket-redeem' ? { ok: m.ticket != null && m.ticket === validTicket } : {};
/** Chromium's `chrome.runtime`: answers through a callback (older versions return no promise). */
const chromeRuntime = {
  sendMessage: (m: { type?: string; ticket?: string }, callback?: (reply: unknown) => void) => {
    setTimeout(() => callback?.(answer(m)), 0);
  },
};
/** Firefox's `browser.runtime`: answers with a promise. */
const browserRuntime = { sendMessage: async (m: { type?: string; ticket?: string }) => answer(m) };

async function loadHost(flavour: 'chrome' | 'firefox' = 'chrome') {
  vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker);
  if (flavour === 'chrome') vi.stubGlobal('chrome', { runtime: chromeRuntime });
  else vi.stubGlobal('browser', { runtime: browserRuntime });
  workers.length = 0;
  vi.resetModules();
  await import('@/synth-host/entry');
}

/** Offer the host a port, as a reader (with a ticket) or as a page (without one). */
function offerPort(ticket?: string) {
  const replies: Array<Record<string, unknown>> = [];
  const port = {
    postMessage: (m: Record<string, unknown>) => replies.push(m),
    start() {},
    close() {},
    onmessage: undefined as undefined | ((e: { data: unknown }) => void),
  };
  window.dispatchEvent(
    Object.assign(new Event('message'), { data: ticket == null ? { __aloud: 'port' } : { __aloud: 'port', ticket }, ports: [port] }),
  );
  return { port, replies };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

describe('the synthesis host', () => {
  beforeEach(async () => {
    validTicket = 'ticket-1';
    await loadHost();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('refuses a port that arrives without a ticket from the background', async () => {
    const { replies } = offerPort();
    await settle();
    expect(replies).toEqual([]);
  });

  it('refuses a made-up ticket', async () => {
    const { replies } = offerPort('guessed');
    await settle();
    expect(replies).toEqual([]);
  });

  it('accepts a reader that brings a valid ticket', async () => {
    const { replies } = offerPort('ticket-1');
    await settle();
    expect(replies[0]).toEqual({ __aloud: 'host-ready' });
  });

  it('accepts a valid ticket in Firefox, where the runtime is `browser`', async () => {
    vi.unstubAllGlobals();
    await loadHost('firefox');
    const { replies } = offerPort('ticket-1');
    await settle();
    expect(replies[0]).toEqual({ __aloud: 'host-ready' });
  });

  it('fails the sentence a crashed worker was holding, and replaces it', async () => {
    const { port, replies } = offerPort('ticket-1');
    await settle();
    port.onmessage?.({
      data: { kind: 'init', id: 1, config: { engine: 'piper', voice: 'en_GB-alba-medium', speed: 1, workers: 1, preferWebGPU: false } },
    });
    await settle();
    const first = workers[0]!;
    first.onmessage?.({ data: { kind: 'ready', id: 1, executionProvider: 'wasm', sampleRate: 22050 } });
    await settle();
    port.onmessage?.({ data: { kind: 'synthesize', id: 2, chunkIndex: 0, text: 'Sentence one.', speed: 1 } });
    await settle();

    first.onerror?.({ message: 'simulated crash after ready', preventDefault() {} });
    await settle();

    // The reader hears about the sentence that will never arrive…
    const failures = replies.filter((r) => r.kind === 'error' && r.fatal === false);
    expect(failures.map((f) => f.chunkIndex)).toEqual([0]);
    // …the dead worker is gone, and a replacement took its place…
    expect(first.terminated).toBe(true);
    expect(workers.length).toBeGreaterThan(1);

    // …so the next sentence is still dispatched rather than stranded.
    const replacement = workers[workers.length - 1]!;
    replacement.onmessage?.({ data: { kind: 'ready', id: 1, executionProvider: 'wasm', sampleRate: 22050 } });
    await settle();
    port.onmessage?.({ data: { kind: 'synthesize', id: 3, chunkIndex: 1, text: 'Sentence two.', speed: 1 } });
    await settle();
    const dispatched = replacement.messages.filter((m) => (m as { kind?: string }).kind === 'synthesize');
    expect(dispatched.map((m) => (m as { chunkIndex: number }).chunkIndex)).toContain(1);
  });

  it('stops replacing a worker that keeps failing, and tells the reader the voice has stopped', async () => {
    const { port, replies } = offerPort('ticket-1');
    await settle();
    port.onmessage?.({
      data: { kind: 'init', id: 1, config: { engine: 'piper', voice: 'en_GB-alba-medium', speed: 1, workers: 1, preferWebGPU: false } },
    });
    await settle();
    workers[0]!.onmessage?.({ data: { kind: 'ready', id: 1, executionProvider: 'wasm', sampleRate: 22050 } });
    await settle();
    // The worker crashes, and every replacement dies before it is ready (a model that no longer loads).
    workers[0]!.onerror?.({ message: 'crash', preventDefault() {} });
    for (let round = 0; round < 6; round++) {
      await new Promise((r) => setTimeout(r, 1100 * (round + 1)));
      const latest = workers[workers.length - 1]!;
      if (latest.terminated) break;
      latest.onerror?.({ message: 'crash again', preventDefault() {} });
    }
    await settle();
    // Bounded: the first worker, then three replacements that never came up — not one per crash for ever.
    expect(workers.length).toBe(4);
    expect(workers.every((w) => w.terminated)).toBe(true);
    const fatal = replies.filter((r) => r.kind === 'error' && r.fatal === true);
    expect(fatal).toHaveLength(1);
    expect(String(fatal[0]!.message)).toMatch(/could not be restarted/);
  }, 20_000);

  it('on falling back from the GPU, starts the extra CPU workers it promised, on the CPU', async () => {
    Object.defineProperty(navigator, 'gpu', { value: { requestAdapter: async () => ({ info: {} }) }, configurable: true });
    Object.defineProperty(navigator, 'hardwareConcurrency', { value: 8, configurable: true });
    try {
      const { port } = offerPort('ticket-1');
      await settle();
      port.onmessage?.({
        data: { kind: 'init', id: 1, config: { engine: 'kokoro', voice: 'af_heart', speed: 1, preferWebGPU: true } },
      });
      await new Promise((r) => setTimeout(r, 50));
      const before = workers.length;
      workers[0]!.onmessage?.({ data: { kind: 'ready', id: 1, executionProvider: 'webgpu', sampleRate: 24000 } });
      await new Promise((r) => setTimeout(r, 50));
      expect(workers.length).toBe(before); // one GPU worker is the whole pool
      // The GPU fails after start-up; the worker carries on, on the CPU.
      workers[0]!.onmessage?.({ data: { kind: 'provider', id: 1, executionProvider: 'wasm' } });
      await new Promise((r) => setTimeout(r, 1600));
      expect(workers.length).toBeGreaterThan(1);
      const inits = workers.slice(1).map((w) => w.messages.find((m) => (m as { kind?: string }).kind === 'init') as { config: { preferWebGPU: boolean } });
      expect(inits.every((m) => m && m.config.preferWebGPU === false)).toBe(true);
    } finally {
      delete (navigator as { gpu?: unknown }).gpu;
    }
  });
});
