// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
const probe = vi.hoisted(() => ({ store: vi.fn() }));
vi.mock('wxt/browser', () => ({ browser: { runtime: { getURL: (p: string) => p } } }));
vi.mock('@/engine/kokoro-voice-files', () => ({ KOKORO_VOICE_STORE: 'kokoro-voices', storeKokoroVoice: probe.store }));
vi.mock('@/engine/installed-voices', () => ({ readCacheSizes: async () => new Map(), sharedModelInstalled: () => true }));
import { downloadSharedModel } from '@/entrypoints/options/downloads';
import { deleteModels } from '@/engine/model-cache';
import { DEFAULT_SETTINGS } from '@/shared/settings';
import { engineConfigFor } from '@/entrypoints/options/engine-config';

function fakeLocks() {
 const state = { shared: 0, exclusive: false };
 return { state, async request(name: string, opts: {mode?: string; ifAvailable?: boolean}, fn: (lock: unknown) => Promise<unknown>) {
   const exclusive = opts.mode !== 'shared';
   if ((exclusive && state.shared) || state.exclusive) { if(opts.ifAvailable) return fn(null); throw new Error('unexpected contention'); }
   if(exclusive) state.exclusive=true; else state.shared++;
   try { return await fn({name}); } finally { if(exclusive) state.exclusive=false; else state.shared--; }
 }};
}
afterEach(() => {vi.unstubAllGlobals();vi.clearAllMocks()});
// Review of 65ec3d3, finding 5: one voice file failing ended the job and let go of the storage
// lock while the other downloads went on, starting new files.
it('keeps failed parallel voice downloads contained until all workers settle', async () => {
 const locks=fakeLocks();vi.stubGlobal('navigator',{...navigator,locks});
 vi.stubGlobal('caches',{open:async()=>({match:async()=>undefined})});
 vi.stubGlobal('Worker',class {postMessage(){} terminate(){} onmessage=null;onerror=null;onmessageerror=null});
 const started:string[]=[];const written:string[]=[];
 const pending=new Map<string,{ok:()=>void;fail:(e:Error)=>void}>();
 probe.store.mockImplementation((id:string)=>{
   started.push(id);
   return new Promise<number>((res,rej)=>pending.set(id,{ok:()=>{written.push(id);res(522240)},fail:rej}));
 });
 const config=engineConfigFor(DEFAULT_SETTINGS,{engine:'kokoro',purpose:'download'});
 const download=downloadSharedModel(config,['a','b','c','d','e'],{set:()=>{},note:()=>{}});
 let settled=false;
 const outcome=download.then(()=> 'resolved',()=> 'rejected').finally(()=>{settled=true});
 await vi.waitFor(()=>expect(started).toEqual(['a','b','c','d']));
 pending.get('a')!.fail(new Error('connection failed'));
 await new Promise(r=>setTimeout(r,20));
 const deleted=vi.fn(async()=>{});
 await deleteModels(deleted).catch(()=>{});
 const atFailure={started:[...started],writers:locks.state.shared,deleted:deleted.mock.calls.length,settled};
 pending.get('b')!.ok();
 await new Promise(r=>setTimeout(r,20));
 pending.get('c')!.ok();pending.get('d')!.ok();pending.get('e')?.ok();
 await outcome;
 // The public download promise must not finish while its sibling requests can keep writing.
 expect(atFailure.deleted,'deletion ran after failure while three voice requests were still alive').toBe(0);
 expect(atFailure.settled,'the job settled while three voice requests were still alive').toBe(false);
 expect(started.slice(atFailure.started.length),'a new voice file started after the failure').toEqual([]);
 expect(await outcome).toBe('rejected');
});
