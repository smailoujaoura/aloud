(function() {
	//#region src/shared/browser-env.ts
	function readUserAgent() {
		try {
			return globalThis.navigator?.userAgent ?? "";
		} catch {
			return "";
		}
	}
	/** Our own extension origin, if an extension API is reachable from this context. */
	function extensionOrigin() {
		const g = globalThis;
		for (const api of [g.browser, g.chrome]) try {
			const url = api?.runtime?.getURL?.("/");
			if (url) return url;
		} catch {}
		return "";
	}
	function detectEngine() {
		const protocol = (() => {
			try {
				return globalThis.location?.protocol ?? "";
			} catch {
				return "";
			}
		})();
		if (protocol === "moz-extension:") return "gecko";
		if (protocol === "chrome-extension:") return "chromium";
		const origin = extensionOrigin();
		if (origin.startsWith("moz-extension:")) return "gecko";
		if (origin.startsWith("chrome-extension:")) return "chromium";
		const ua = readUserAgent();
		if (/firefox\/|gecko\//i.test(ua)) return "gecko";
		if (/chrome\/|chromium\/|edg\//i.test(ua)) return "chromium";
		return "unknown";
	}
	function detectFormFactor() {
		return /android/i.test(readUserAgent()) ? "android" : "desktop";
	}
	function computeCapabilities() {
		const engine = detectEngine();
		const formFactor = detectFormFactor();
		const chromium = engine === "chromium";
		return {
			engine,
			formFactor,
			workerWebGPU: chromium && formFactor === "desktop",
			contentScriptCanSpawnExtensionWorker: chromium,
			menusTargetElement: engine === "gecko",
			backgroundIsServiceWorker: chromium,
			touchFirst: formFactor === "android"
		};
	}
	var cached$1 = null;
	/** The current context's capabilities. Computed once — nothing here changes at run time. */
	function capabilities() {
		return cached$1 ??= computeCapabilities();
	}
	//#endregion
	//#region src/shared/gpu-probe.ts
	function gpuOf(scope) {
		return scope?.navigator?.gpu;
	}
	var cached = null;
	var inFlight = null;
	var UNSUPPORTED = {
		status: "unsupported",
		available: false,
		detail: "This browser does not expose WebGPU here, so synthesis runs on the CPU."
	};
	/**
	* Probe once and remember the answer.
	*
	* Never throws: a browser that implements `navigator.gpu` badly (or a policy that makes
	* `requestAdapter` reject) must degrade to "no GPU", not break synthesis.
	*/
	function probeGpu(scope = globalThis) {
		if (cached) return Promise.resolve(cached);
		if (inFlight) return inFlight;
		const gpu = gpuOf(scope);
		if (!gpu) {
			cached = UNSUPPORTED;
			return Promise.resolve(cached);
		}
		inFlight = (async () => {
			try {
				const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
				if (!adapter) return {
					status: "no-adapter",
					available: false,
					detail: "WebGPU is present but no GPU adapter was granted, so synthesis runs on the CPU. On Linux this usually means the browser has no Vulkan-capable GPU driver."
				};
				let adapterInfo;
				let shaderF16 = false;
				try {
					const info = adapter.info ?? await adapter.requestAdapterInfo?.();
					const parts = info ? Object.entries(info).filter(([, v]) => typeof v === "string" && v).map(([k, v]) => `${k}=${String(v)}`) : [];
					adapterInfo = parts.length ? parts.join(" ") : void 0;
					shaderF16 = adapter.features ? [...adapter.features].includes("shader-f16") : false;
				} catch {}
				return {
					status: "available",
					available: true,
					adapterInfo,
					shaderF16,
					detail: `GPU acceleration is active${adapterInfo ? ` (${adapterInfo})` : ""}.`
				};
			} catch (err) {
				return {
					status: "no-adapter",
					available: false,
					detail: `Asking for a GPU adapter failed (${err instanceof Error ? err.message : String(err)}), so synthesis runs on the CPU.`
				};
			}
		})().then((result) => {
			cached = result;
			inFlight = null;
			return result;
		}).catch(() => {
			cached = UNSUPPORTED;
			inFlight = null;
			return cached;
		});
		return inFlight;
	}
	//#endregion
	//#region src/synth-host/job-queue.ts
	/**
	* Which worker gets the next sentence.
	*
	* The pool only pays for itself if the sentences are spread across it, and the naive way to do
	* that — round-robin each request to the workers that exist when it arrives — quietly fails in
	* the one case that matters. The reader asks for its whole lookahead (24 sentences for Kokoro on
	* the CPU) the instant worker 0 says `ready`, which is *seconds* before workers 1..N finish
	* compiling their own copy of the model. Round-robin therefore posts all 24 to worker 0, they sit
	* in that worker's private queue, and the rest of the pool comes up to find nothing to do. That
	* is a pool that costs four models' worth of memory and synthesises at exactly one worker's speed
	* — measured: 4 sentences in ~50 s, each one starting only after the previous finished.
	*
	* So jobs are held *here* instead, and handed out one at a time to a worker that is idle. A
	* worker holds exactly the sentence it is working on, and every worker that comes up later
	* immediately pulls the next job from the queue. It also makes a seek cheap: the sentences the
	* user just skipped past are still in this queue and are dropped by `clear()`, rather than being
	* buried in four workers' internal queues.
	*
	* Generic over the worker and job types, and free of globals, so the policy can be tested without
	* a DOM or a real Worker.
	*/
	var JobQueue = class {
		send;
		keyOf;
		pending = [];
		/** Which job each working worker is on — the queue is also the record of what is in flight. */
		busy = /* @__PURE__ */ new Map();
		constructor(send, keyOf) {
			this.send = send;
			this.keyOf = keyOf;
		}
		/** Jobs waiting for a free worker. */
		get pendingCount() {
			return this.pending.length;
		}
		/** Workers currently synthesising. */
		get busyCount() {
			return this.busy.size;
		}
		/** What each busy worker is working on. */
		busyJobs() {
			return [...this.busy];
		}
		/**
		* Queue a job, then hand out as much work as the pool can take right now.
		*
		* A job already queued or already running is dropped. That is what makes it safe for a seek to
		* leave in-flight work alone: the reader re-requests the sentences around the new position, and
		* the one a worker is already halfway through is recognised rather than started a second time.
		*/
		submit(job, ready) {
			const key = this.keyOf(job);
			if (this.pending.some((queued) => this.keyOf(queued) === key)) return;
			for (const running of this.busy.values()) if (this.keyOf(running) === key) return;
			this.pending.push(job);
			this.pump(ready);
		}
		/** A worker finished, failed, or was cancelled — it can take the next job. */
		release(worker, ready) {
			this.busy.delete(worker);
			this.pump(ready);
		}
		/** A worker is gone for good (terminated). Whatever it held is gone with it. */
		forget(worker) {
			this.busy.delete(worker);
		}
		/** Give queued jobs to idle workers, in arrival order. Also how a new worker gets its first. */
		pump(ready) {
			for (const worker of ready) {
				if (this.pending.length === 0) return;
				if (this.busy.has(worker)) continue;
				const job = this.pending.shift();
				this.busy.set(worker, job);
				this.send(worker, job);
			}
		}
		/**
		* Drop everything not yet started.
		*
		* A seek or speed change invalidates the queue: the reader re-requests exactly what it still
		* wants. What to do about work already *running* is a separate decision — see the synth-host,
		* which cannot interrupt a worker and terminates the ones whose sentence is no longer wanted.
		*/
		clear() {
			this.pending.length = 0;
		}
		/** Forget the pool entirely (teardown, or a new `init`). */
		reset() {
			this.pending.length = 0;
			this.busy.clear();
		}
	};
	var clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
	/** Clamp a user-pinned worker count into the supported range. */
	function clampPool(requested) {
		return clamp(Math.round(requested), 1, 6);
	}
	function autoPoolSize(engine, gpu, env) {
		if (engine === "piper") return 1;
		if (gpu) return 1;
		if (env.touchFirst) return 1;
		const cores = Math.max(1, env.cores);
		if (engine === "supertonic") return clamp(cores - 2, 1, 2);
		return clamp(cores - 2, 2, 4);
	}
	/**
	* The pool size the engine's *actual* execution provider justifies.
	*
	* Worker 0 reports the provider it ended up on (`ready.executionProvider`), which is the only
	* fully trustworthy signal: the pre-flight probe runs in the synth-host document, and a browser
	* may grant a document a GPU it does not grant a worker. So the pool is re-sized once the truth
	* is in, and grows if the GPU turned out not to be there.
	*/
	function poolSizeForProvider(engine, provider, env) {
		return autoPoolSize(engine, provider.startsWith("webgpu"), env);
	}
	//#endregion
	//#region src/synth-host/entry.ts
	var WORKER_URL = new URL("/tts-worker.js", location.href).href;
	/** Whether to print what is being read. Set from the reader's `debug` setting on `init`. */
	var verbose = false;
	/** Collect transferable ArrayBuffers anywhere in a (shallow) message tree. */
	function collectBuffers(value, out, depth = 0) {
		if (value == null || depth > 4) return;
		if (value instanceof ArrayBuffer) out.push(value);
		else if (ArrayBuffer.isView(value)) out.push(value.buffer);
		else if (Array.isArray(value)) for (const v of value) collectBuffers(v, out, depth + 1);
		else if (typeof value === "object") for (const v of Object.values(value)) collectBuffers(v, out, depth + 1);
	}
	/** What the pool sizing needs to know about the machine it is running on. */
	function poolEnv() {
		return {
			cores: Math.max(1, navigator.hardwareConcurrency || 4),
			touchFirst: capabilities().touchFirst
		};
	}
	var port = null;
	var disposed = false;
	var initMsg = null;
	var targetSize = 1;
	/** True when the user pinned a worker count in settings — never second-guess that. */
	var poolIsFixed = false;
	/** Bumped per `init`, so a probe still running for a superseded init cannot start a stale pool. */
	var initGeneration = 0;
	/**
	* Synthesis requests that arrived while the GPU probe was still running.
	*
	* Sizing the pool needs the probe, so worker 0 is now created one microtask-chain later than it
	* used to be. Anything the content script sends in that window is held here rather than dropped
	* — a dropped `synthesize` is a sentence that never plays.
	*/
	var preStartRequests = [];
	var allWorkers = [];
	var readyWorkers = [];
	/** One queue for the whole pool; a worker is given the next sentence only when it is free. */
	var jobs = new JobQueue((worker, job) => {
		const buffers = [];
		collectBuffers(job, buffers);
		try {
			worker.postMessage(job, buffers);
		} catch {}
		dispatched.set(job.chunkIndex, {
			at: performance.now(),
			worker
		});
		console.info(`[aloud] ${clock()} ${workerName(worker)} ← chunk ${job.chunkIndex} ${verbose ? `"${preview(job.text)}" ` : ""}(${job.text.length} chars) · ${poolState()}`);
	}, (job) => job.chunkIndex);
	/** Worker names are for debugging, so they keep counting up as workers are replaced. */
	var nextWorkerId = 0;
	/**
	* Pipeline logging.
	*
	* This is the one place that sees the whole picture — which worker got which sentence, when, how
	* deep the queue was, and how long the answer took — so it is the only place that logs it. The
	* worker and the engine used to log a line each, from two clocks, with no worker identity and no
	* queue state, which made it impossible to tell a slow sentence from a starved pool.
	*
	* Every line is stamped with seconds since the pool started, so the log reads as a timeline.
	*/
	var workerIds = /* @__PURE__ */ new WeakMap();
	var dispatched = /* @__PURE__ */ new Map();
	var poolStart = 0;
	function clock() {
		return `${((performance.now() - poolStart) / 1e3).toFixed(1)}s`.padStart(7);
	}
	function workerName(worker) {
		const id = workerIds.get(worker);
		return id == null ? "w?" : `w${id}`;
	}
	/** "queue 9 · busy 3/4" — what the pool is doing at this instant. */
	function poolState() {
		return `queue ${jobs.pendingCount} · busy ${jobs.busyCount}/${readyWorkers.length}`;
	}
	function preview(text) {
		const flat = text.replace(/\s+/g, " ").trim();
		return flat.length <= 32 ? flat : `${flat.slice(0, 31)}…`;
	}
	var readyForwarded = false;
	var maxProgress = 0;
	/** The largest download total reported so far (see the `model-progress` relay). */
	var maxTotal = 0;
	/**
	* Replacement workers that died before they were ever ready, since the pool last made progress
	* (a worker became ready, or a sentence came back). A replacement that fails the same way every
	* time — a model that no longer loads, memory that has run out — used to be replaced for ever,
	* each one failing in turn, while the reader waited on sentences nobody was making.
	*/
	var restartFailures = 0;
	var MAX_RESTART_FAILURES = 3;
	function relay(data) {
		if (!port) return;
		const buffers = [];
		collectBuffers(data, buffers);
		try {
			port.postMessage(data, buffers);
		} catch {}
	}
	function fatalToContent(phase, message, stack) {
		if (readyForwarded) return;
		readyForwarded = true;
		port?.postMessage({
			kind: "error",
			id: 0,
			fatal: true,
			phase: `synth-host:${phase}`,
			message,
			stack
		});
	}
	/**
	* A worker died. Before readiness that is a failed start-up, and the whole init fails; after it,
	* it is one worker of a pool, and the reader must hear about the sentences it was holding.
	*
	* Silence was the old behaviour — `fatalToContent` returns as soon as readiness is forwarded —
	* so a crash mid-article left its sentence marked in-flight for ever: the session kept waiting
	* for audio that could not arrive, and the queue behind it never moved.
	*/
	function workerFailed(w, phase, message, stack) {
		if (!readyForwarded) {
			fatalToContent(phase, message, stack);
			return;
		}
		for (const [chunkIndex, entry] of [...dispatched]) {
			if (entry.worker !== w) continue;
			dispatched.delete(chunkIndex);
			relay({
				kind: "error",
				id: 0,
				fatal: false,
				chunkIndex,
				phase: `synth-host:${phase}`,
				message,
				stack
			});
		}
		console.warn(`[aloud] ${clock()} ${workerName(w)} failed after ready (${phase}): ${message}`);
		if (!readyWorkers.includes(w)) restartFailures++;
		if (restartFailures >= MAX_RESTART_FAILURES) {
			replaceWorker(w, false);
			if (allWorkers.length === 0) {
				jobs.clear();
				relay({
					kind: "error",
					id: 0,
					fatal: true,
					phase: `synth-host:${phase}`,
					message: `The voice stopped working and could not be restarted (${message}). Close the reader and start it again.`,
					stack
				});
				return;
			}
		} else replaceWorker(w, true, restartFailures * 1e3);
		jobs.pump(readyWorkers);
	}
	function makeWorker(idx) {
		let w;
		try {
			w = new Worker(WORKER_URL, {
				type: "module",
				name: `aloud-tts-${idx}`
			});
		} catch (err) {
			fatalToContent(`new Worker(${idx})`, err instanceof Error ? err.message : String(err));
			return null;
		}
		workerIds.set(w, idx);
		w.onmessage = (ev) => onWorkerMessage(w, ev.data);
		w.onerror = (ev) => {
			ev.preventDefault?.();
			const where = ev.filename && ev.filename !== "" ? ` (${ev.filename}:${ev.lineno ?? 0}:${ev.colno ?? 0})` : "";
			workerFailed(w, `worker[${idx}].onerror`, (ev.message || ev.error?.message || "the synthesis worker failed to start") + where, ev.error?.stack);
		};
		w.onmessageerror = () => workerFailed(w, `worker[${idx}].onmessageerror`, "worker sent an unreadable message");
		return w;
	}
	function onWorkerMessage(w, data) {
		if (!port || !data || typeof data !== "object") return;
		switch (data.kind) {
			case "ready":
				restartFailures = 0;
				if (!readyWorkers.includes(w)) readyWorkers.push(w);
				console.info(`[aloud] ${clock()} ${workerName(w)} ready on ${data.executionProvider} · ${poolState()}`);
				jobs.pump(readyWorkers);
				if (!readyForwarded) {
					readyForwarded = true;
					relay(data);
					resizePoolForProvider(data.executionProvider);
					spawnRest();
				}
				return;
			case "provider":
				console.info(`[aloud] ${clock()} ${workerName(w)} now on ${data.executionProvider} · resizing the pool`);
				if (initMsg && data.executionProvider === "wasm" && initMsg.config.preferWebGPU) initMsg = {
					...initMsg,
					config: {
						...initMsg.config,
						preferWebGPU: false
					}
				};
				resizePoolForProvider(data.executionProvider);
				spawnRest();
				relay(data);
				return;
			case "model-progress":
				if (data.progress >= maxProgress || data.total > maxTotal) {
					maxProgress = data.progress;
					maxTotal = Math.max(maxTotal, data.total);
					relay(data);
				}
				return;
			case "error":
				if (data.fatal) {
					if (!readyForwarded) {
						readyForwarded = true;
						relay(data);
					} else workerFailed(w, "worker.fatal", data.message, data.stack);
				} else {
					if (data.chunkIndex != null) jobs.release(w, readyWorkers);
					relay(data);
				}
				return;
			case "audio": {
				restartFailures = 0;
				const seconds = data.sampleRate > 0 ? data.pcm.byteLength / 4 / data.sampleRate : 0;
				const started = dispatched.get(data.chunkIndex);
				dispatched.delete(data.chunkIndex);
				const took = started ? (performance.now() - started.at) / 1e3 : 0;
				console.info(`[aloud] ${clock()} ${workerName(w)} → chunk ${data.chunkIndex} in ${took.toFixed(1)}s → ${seconds.toFixed(1)}s audio · RTF ${seconds > 0 ? (took / seconds).toFixed(2) : "?"}× · ` + poolState());
				jobs.release(w, readyWorkers);
				relay(data);
				return;
			}
			case "cancelled":
				jobs.release(w, readyWorkers);
				relay(data);
				return;
			default: relay(data);
		}
	}
	/** After worker 0 is ready, bring the rest of the pool up, lightly staggered. */
	function spawnRest() {
		for (let i = allWorkers.length; i < targetSize; i++) {
			const delay = (i - 1) * 700;
			setTimeout(() => {
				if (disposed || !initMsg || allWorkers.length >= targetSize) return;
				const w = makeWorker(nextWorkerId++);
				if (!w) return;
				allWorkers.push(w);
				w.postMessage(initMsg);
			}, delay);
		}
	}
	/**
	* Throw a worker away and start a fresh one in its place.
	*
	* This is the only way to stop synthesis that is already running. `engine.synthesize()` is a
	* blocking WASM call, so a worker in the middle of one does not read its messages at all — a
	* `cancel` sits unseen until the sentence finishes, which on the CPU path is up to a minute for a
	* long sentence. Measured on a real seek: three of four workers spent 40-65 s each finishing
	* sentences the user had already skipped past, while the sentence they had jumped to waited for
	* the one worker that happened to be free.
	*
	* Terminating costs a model reload, but the weights are already in the cache, so a replacement is
	* ready in a few seconds — against up to a minute of a worker being useless.
	*/
	function replaceWorker(worker, replace = true, delayMs = 0) {
		const all = allWorkers.indexOf(worker);
		if (all >= 0) allWorkers.splice(all, 1);
		const ready = readyWorkers.indexOf(worker);
		if (ready >= 0) readyWorkers.splice(ready, 1);
		jobs.forget(worker);
		try {
			worker.terminate();
		} catch {}
		if (!replace) return;
		const start = () => {
			if (disposed || !initMsg || allWorkers.length >= targetSize) return;
			const replacement = makeWorker(nextWorkerId++);
			if (!replacement) return;
			allWorkers.push(replacement);
			replacement.postMessage(initMsg);
		};
		if (delayMs > 0) setTimeout(start, delayMs);
		else start();
	}
	/**
	* A seek or a speed change: drop the queue, and decide what to do about work already running.
	*
	* `keepAhead` says how many sentences from the new position are still wanted. A worker inside
	* that window is left alone — the reader is about to ask for that very sentence again, and the
	* queue recognises the duplicate rather than starting it twice. Every other busy worker is
	* replaced, because it cannot be told to stop.
	*/
	function handleCancel(msg) {
		jobs.clear();
		const from = msg.fromChunkIndex;
		const until = from + Math.max(0, msg.keepAhead);
		const kept = /* @__PURE__ */ new Set();
		const dropped = [];
		for (const [worker, job] of jobs.busyJobs()) if (job.chunkIndex >= from && job.chunkIndex < until) kept.add(worker);
		else {
			dropped.push(`${workerName(worker)}:${job.chunkIndex}`);
			dispatched.delete(job.chunkIndex);
			replaceWorker(worker);
		}
		console.info(`[aloud] ${clock()} seek to ${from}: dropped queue, ` + (dropped.length > 0 ? `terminated ${dropped.join(", ")} (mid-sentence, cannot be interrupted)` : "no worker needed replacing") + `${kept.size > 0 ? `, kept ${kept.size} in the new window` : ""}`);
		for (const worker of allWorkers) {
			if (kept.has(worker)) continue;
			try {
				worker.postMessage(msg);
			} catch {}
		}
	}
	function broadcast(msg) {
		for (const w of allWorkers) try {
			w.postMessage(msg);
		} catch {}
	}
	function teardown() {
		disposed = true;
		for (const w of allWorkers) try {
			w.terminate();
		} catch {}
		allWorkers.length = 0;
		readyWorkers.length = 0;
		jobs.reset();
	}
	async function startPool(msg, gen) {
		const engine = msg.config.engine;
		const requested = msg.config.workers ?? 0;
		poolStart = performance.now();
		nextWorkerId = 0;
		dispatched.clear();
		const probe = engine === "piper" ? {
			available: false,
			status: "unsupported",
			adapterInfo: void 0
		} : await probeGpu();
		if (disposed || gen !== initGeneration) return;
		poolIsFixed = requested > 0;
		targetSize = engine === "piper" ? 1 : poolIsFixed ? clampPool(requested) : autoPoolSize(engine, probe.available, poolEnv());
		verbose = msg.config.debug === true;
		initMsg = msg;
		console.info(`[aloud] ${clock()} pool target ${targetSize} worker(s) for ${engine} (gpu ${probe.status}${probe.adapterInfo ? `: ${probe.adapterInfo}` : ""})`);
		const w0 = makeWorker(nextWorkerId++);
		if (!w0) return;
		allWorkers.push(w0);
		w0.postMessage(initMsg);
		for (const held of preStartRequests.splice(0)) handleFromContent(held);
	}
	/**
	* Re-size the pool once worker 0 reports the provider it actually got.
	*
	* The pre-flight probe runs in this document; the worker is where synthesis happens. If they
	* disagree — a browser that grants the GPU to documents but not to workers, an adapter lost
	* between the two — the worker wins, and a pool that was sized for a GPU that never arrived
	* grows here instead of leaving playback to stall behind one CPU worker.
	*/
	function resizePoolForProvider(provider) {
		if (!initMsg || poolIsFixed) return;
		const engine = initMsg.config.engine;
		if (engine === "piper") return;
		const wanted = poolSizeForProvider(engine, provider, poolEnv());
		if (wanted <= targetSize) return;
		console.info(`[aloud] ${clock()} engine reported "${provider}"; growing pool ${targetSize} → ${wanted} worker(s)`);
		targetSize = wanted;
	}
	function handleFromContent(msg) {
		if (!msg || typeof msg !== "object") return;
		if (msg.kind === "init") {
			teardown();
			disposed = false;
			readyForwarded = false;
			maxProgress = 0;
			maxTotal = 0;
			restartFailures = 0;
			initMsg = null;
			preStartRequests.length = 0;
			startPool(msg, ++initGeneration);
			return;
		}
		if (allWorkers.length === 0 && !disposed) {
			if (msg.kind === "synthesize" || msg.kind === "cancel" || msg.kind === "set-speed") preStartRequests.push(msg);
			if (msg.kind !== "dispose") return;
		}
		if (msg.kind === "synthesize") {
			jobs.submit(msg, readyWorkers);
			return;
		}
		if (msg.kind === "cancel") {
			handleCancel(msg);
			return;
		}
		if (msg.kind === "dispose") {
			broadcast(msg);
			teardown();
			return;
		}
		broadcast(msg);
	}
	/**
	* A reader transfers us one MessagePort; everything flows over it after that.
	*
	* This page is web-accessible, so the offer can come from any page that embeds it — the sender's
	* origin is the embedding page either way, which is why it cannot be used to tell a content
	* script from page script. What a page cannot do is obtain a ticket from the background, so the
	* port is only accepted once the ticket it arrives with has been redeemed there.
	*/
	window.addEventListener("message", (ev) => {
		const data = ev.data;
		if (!data || data.__aloud !== "port" || !ev.ports[0]) return;
		const offered = ev.ports[0];
		redeemTicket(data.ticket).then((ok) => {
			if (!ok) {
				offered.close?.();
				return;
			}
			port?.close?.();
			port = offered;
			port.onmessage = (pev) => handleFromContent(pev.data);
			port.start?.();
			port.postMessage({ __aloud: "host-ready" });
		});
	});
	async function redeemTicket(ticket) {
		const scope = globalThis;
		const message = {
			type: "synth-ticket-redeem",
			ticket
		};
		try {
			if (scope.browser?.runtime?.sendMessage) return (await scope.browser.runtime.sendMessage(message))?.ok === true;
			const runtime = scope.chrome?.runtime;
			if (!runtime?.sendMessage) return false;
			return (await new Promise((resolve) => {
				runtime.sendMessage(message, (answer) => {
					runtime.lastError;
					resolve(answer);
				});
			}))?.ok === true;
		} catch {
			return false;
		}
	}
	window.addEventListener("pagehide", teardown);
	//#endregion
})();
