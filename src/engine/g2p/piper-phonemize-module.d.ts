/** The Emscripten glue shipped by @diffusionstudio/piper-wasm (piper_phonemize compiled to WASM). */
declare module '@diffusionstudio/piper-wasm/build/piper_phonemize.js' {
  export interface PiperPhonemizeModule {
    /** Runs the command-line `piper_phonemize` main; output arrives through `print`. */
    callMain(args: string[]): number;
  }

  export interface PiperPhonemizeOptions {
    print?: (line: string) => void;
    printErr?: (line: string) => void;
    locateFile?: (file: string) => string;
    /** Supplies the preloaded `.data` package (espeak-ng-data) instead of fetching it. */
    getPreloadedPackage?: (name: string, size: number) => ArrayBuffer;
    /** Supplies the compiled WASM instance instead of letting the glue fetch it. */
    instantiateWasm?: (
      imports: WebAssembly.Imports,
      done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
    ) => Record<string, never>;
  }

  const createPiperPhonemize: (options: PiperPhonemizeOptions) => Promise<PiperPhonemizeModule>;
  export default createPiperPhonemize;
}
