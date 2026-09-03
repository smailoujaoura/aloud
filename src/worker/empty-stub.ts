// Stub for Node built-ins (`path`, `fs`, `fs/promises`) that kokoro-js / transformers reference
// behind environment guards that never fire in the browser worker.
export default {};
export const readFile = undefined;
export const resolve = undefined;
export const join = undefined;
