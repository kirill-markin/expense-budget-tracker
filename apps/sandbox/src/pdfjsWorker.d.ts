/**
 * The one pdf.js file that ships without types, and the global it is put into.
 *
 * `pdfjs-dist/legacy/build/pdf.mjs` has `pdf.d.mts` beside it; its worker build
 * has none, so the static import prepareOperation.ts needs in order to survive
 * bundling would otherwise be a module TypeScript cannot resolve at all. Only
 * the shape pdf.js itself looks for is declared: it reads
 * `globalThis.pdfjsWorker?.WorkerMessageHandler` and uses the handler instead of
 * loading a worker through a runtime import no bundler can follow.
 */
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}

/**
 * A top-level `declare var` rather than a `declare global` block, because this
 * file has to stay a script: an `import` or `export` anywhere in it would make
 * it a module, which turns the ambient declaration above into an augmentation
 * of a module TypeScript cannot resolve. In a script, a top-level `declare`
 * already lands on `globalThis`, so no block is needed - and `declare global`
 * is not merely redundant here but illegal, reported as TS2669 that
 * `skipLibCheck` then hides inside a `.d.ts`, leaving the declaration inert and
 * the use site failing as an implicit `any` index of `globalThis`.
 */
declare var pdfjsWorker: unknown;
