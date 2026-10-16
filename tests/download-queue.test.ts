/**
 * Voice downloads run one at a time; the others wait in line and say so.
 */
import { describe, expect, it } from 'vitest';
import { DownloadCancelled, DownloadQueue, type ProgressSink } from '@/entrypoints/options/download-queue';

/** A download that finishes when the test says. */
function controlled() {
  let finish!: () => void;
  let fail!: (err: Error) => void;
  let sink!: ProgressSink;
  let started = false;
  const run = (p: ProgressSink) =>
    new Promise<void>((ok, no) => {
      started = true;
      sink = p;
      finish = ok;
      fail = no;
    });
  return { run, finish: () => finish(), fail: (e: Error) => fail(e), sink: () => sink, started: () => started };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('the download line', () => {
  it('runs one download at a time, in the order they were asked for', async () => {
    const q = new DownloadQueue();
    const a = controlled();
    const b = controlled();
    const c = controlled();
    const done: string[] = [];
    void q.enqueue('a', 'Alba', a.run).then(() => done.push('a'));
    void q.enqueue('b', 'Ryan', b.run).then(() => done.push('b'));
    void q.enqueue('c', 'Kokoro-82M model', c.run).then(() => done.push('c'));
    await tick();
    expect([a.started(), b.started(), c.started()]).toEqual([true, false, false]);

    a.finish();
    await tick();
    expect(b.started()).toBe(true);
    expect(c.started()).toBe(false);
    b.finish();
    await tick();
    c.finish();
    await tick();
    expect(done).toEqual(['a', 'b', 'c']);
    expect(q.busy).toBe(false);
  });

  it('tells a waiting download what it is waiting for, and where it is in line', async () => {
    const q = new DownloadQueue();
    const a = controlled();
    void q.enqueue('a', 'Alba', a.run);
    void q.enqueue('b', 'Ryan', controlled().run);
    void q.enqueue('c', 'Lessac', controlled().run);
    await tick();
    expect(q.view('b')!.text).toBe('Waiting — starts after Alba finishes (next in line)');
    expect(q.view('c')!.text).toBe('Waiting — starts after Alba finishes (2nd in line)');
    a.sink().set(0.42);
    expect(q.view('a')).toMatchObject({ phase: 'downloading', ratio: 0.42 });
    a.sink().note('Downloaded — preparing the model…');
    expect(q.view('a')!.phase).toBe('preparing');
  });

  it('lets a waiting download leave the line, and moves the rest up', async () => {
    const q = new DownloadQueue();
    void q.enqueue('a', 'Alba', controlled().run);
    const b = q.enqueue('b', 'Ryan', controlled().run);
    void q.enqueue('c', 'Lessac', controlled().run);
    await tick();
    q.cancel('b');
    await expect(b).rejects.toBeInstanceOf(DownloadCancelled);
    expect(q.view('b')).toBeNull();
    expect(q.view('c')!.text).toContain('next in line');
    q.cancel('a'); // the running one is not cancelled from here
    expect(q.view('a')!.phase).toBe('downloading');
  });

  it('pressing Download twice joins the same download', async () => {
    const q = new DownloadQueue();
    const a = controlled();
    const first = q.enqueue('a', 'Alba', a.run);
    const second = q.enqueue('a', 'Alba', controlled().run);
    expect(q.all()).toHaveLength(1);
    await tick();
    a.finish();
    await expect(Promise.all([first, second])).resolves.toBeDefined();
  });

  it('a failure is shown on its row, and the next download still runs', async () => {
    const q = new DownloadQueue();
    const a = controlled();
    const b = controlled();
    const failed = q.enqueue('a', 'Alba', a.run);
    void q.enqueue('b', 'Ryan', b.run);
    await tick();
    a.fail(new Error('Download failed (503)'));
    await expect(failed).rejects.toThrow('503');
    await tick();
    expect(q.view('a')).toMatchObject({ phase: 'failed', text: 'Download failed (503)' });
    expect(b.started()).toBe(true);
  });

  it('cancels the download under way: it stops, and the next starts only once it has', async () => {
    const q = new DownloadQueue();
    let signal!: AbortSignal;
    let stopped!: () => void;
    // A download that stops when cancelled — a moment later, as real requests do.
    const a = (_p: ProgressSink, s: AbortSignal) =>
      new Promise<void>((_ok, no) => {
        signal = s;
        stopped = () => no(new DOMException('Aborted', 'AbortError'));
      });
    const b = controlled();
    const outcome = q.enqueue('a', 'Alba', a).then(() => 'done', (e: unknown) => e);
    void q.enqueue('b', 'Ryan', b.run);
    await tick();
    expect(q.cancellable('a')).toBe(true);

    q.cancel('a');
    expect(signal.aborted).toBe(true);
    expect(q.view('a')?.text).toBe('Cancelling Alba…');
    expect(q.cancellable('a')).toBe(false);
    await tick();
    expect(b.started()).toBe(false); // still stopping: nothing of it may run beside the next

    stopped();
    await tick();
    expect(await outcome).toBeInstanceOf(DownloadCancelled);
    expect(q.view('a')).toBeNull(); // cancelled, not failed: no error left on its row
    expect(b.started()).toBe(true);
  });

  it('cannot cancel a download being prepared, once its bytes are in', async () => {
    const q = new DownloadQueue();
    let signal!: AbortSignal;
    let sink!: ProgressSink;
    let finish!: () => void;
    void q.enqueue('k', 'Kokoro-82M model', (p, s) => new Promise<void>((ok) => ((sink = p), (signal = s), (finish = ok))));
    await tick();
    sink.note('Downloaded — preparing the model…');
    expect(q.cancellable('k')).toBe(false);
    q.cancel('k');
    expect(signal.aborted).toBe(false);
    finish();
  });
});
