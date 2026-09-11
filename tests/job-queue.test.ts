import { describe, it, expect } from 'vitest';
import { JobQueue } from '@/synth-host/job-queue';

type Sent = [string, string];

/** Jobs are plain strings here; their trailing digits stand in for the chunk index. */
function makeQueue() {
  const sent: Sent[] = [];
  const q = new JobQueue<string, string>(
    (worker, job) => sent.push([worker, job]),
    (job) => Number(job.replace(/\D/g, '')),
  );
  return { q, sent };
}

describe('JobQueue', () => {
  it('spreads jobs across idle workers instead of piling them on the first', () => {
    const { q, sent } = makeQueue();
    const pool = ['w0', 'w1', 'w2'];

    for (const job of ['s0', 's1', 's2']) q.submit(job, pool);

    expect(sent).toEqual([
      ['w0', 's0'],
      ['w1', 's1'],
      ['w2', 's2'],
    ]);
  });

  it('holds the overflow rather than double-booking a busy worker', () => {
    const { q, sent } = makeQueue();
    const pool = ['w0', 'w1'];

    for (const job of ['s0', 's1', 's2', 's3']) q.submit(job, pool);

    expect(sent).toHaveLength(2);
    expect(q.pendingCount).toBe(2);
    expect(q.busyCount).toBe(2);
  });

  it('gives a worker the next job when it finishes', () => {
    const { q, sent } = makeQueue();
    const pool = ['w0'];

    q.submit('s0', pool);
    q.submit('s1', pool);
    expect(sent).toEqual([['w0', 's0']]);

    q.release('w0', pool);
    expect(sent).toEqual([
      ['w0', 's0'],
      ['w0', 's1'],
    ]);
  });

  /**
   * The case the round-robin dispatcher got wrong: the reader asks for its whole lookahead the
   * moment worker 0 is ready, seconds before the rest of the pool has compiled its model.
   */
  it('hands the backlog to workers that only come up later', () => {
    const { q, sent } = makeQueue();
    const pool: string[] = ['w0'];

    for (const job of ['s0', 's1', 's2', 's3']) q.submit(job, pool);
    expect(sent).toEqual([['w0', 's0']]);

    pool.push('w1');
    q.pump(pool);
    pool.push('w2');
    q.pump(pool);

    expect(sent).toEqual([
      ['w0', 's0'],
      ['w1', 's1'],
      ['w2', 's2'],
    ]);
    expect(q.pendingCount).toBe(1);
  });

  it('drops the queue on a seek but leaves running work alone', () => {
    const { q, sent } = makeQueue();
    const pool = ['w0'];

    q.submit('s0', pool);
    q.submit('s1', pool);
    q.clear();

    expect(q.pendingCount).toBe(0);
    expect(q.busyCount).toBe(1);

    q.submit('s9', pool);
    expect(sent).toEqual([['w0', 's0']]); // w0 is still on s0; s9 waits its turn
    q.release('w0', pool);
    expect(sent).toEqual([
      ['w0', 's0'],
      ['w0', 's9'],
    ]);
  });

  it('never hands the same sentence to two workers at once', () => {
    const { q, sent } = makeQueue();
    const pool = ['w0', 'w1'];

    q.submit('s0', pool); // running on w0
    q.submit('s1', pool); // running on w1
    q.submit('s0', pool); // the reader re-requested it after a seek — already in flight
    q.submit('s2', pool);
    q.submit('s2', pool); // already queued

    expect(sent).toEqual([
      ['w0', 's0'],
      ['w1', 's1'],
    ]);
    expect(q.pendingCount).toBe(1); // just s2
  });

  it('reports what each worker is working on, so the host can decide who to replace', () => {
    const { q } = makeQueue();
    const pool = ['w0', 'w1'];
    q.submit('s7', pool);
    q.submit('s8', pool);

    expect(q.busyJobs()).toEqual([
      ['w0', 's7'],
      ['w1', 's8'],
    ]);
  });

  it('frees the slot of a worker that was terminated rather than finished', () => {
    const { q, sent } = makeQueue();
    const pool = ['w0'];
    q.submit('s0', pool);
    q.submit('s1', pool);

    q.forget('w0'); // terminated mid-sentence; it will never report back
    expect(q.busyCount).toBe(0);
    expect(sent).toHaveLength(1); // forgetting alone hands out nothing

    q.pump(['w9']);
    expect(sent[1]).toEqual(['w9', 's1']);
  });

  it('forgets everything on teardown', () => {
    const { q } = makeQueue();
    const pool = ['w0'];
    q.submit('s0', pool);
    q.submit('s1', pool);

    q.reset();

    expect(q.pendingCount).toBe(0);
    expect(q.busyCount).toBe(0);
  });
});
