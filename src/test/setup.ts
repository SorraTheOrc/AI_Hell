/**
 * Shared test harness: makes Phaser importable and bootable inside
 * happy-dom (no real browser canvas exists in CI).
 *
 * Phaser probes `window.CanvasRenderingContext2D` and constructs a real
 * 2D context at module scope for feature detection. happy-dom's canvas
 * has no rendering backend, so we stub the 2D context with a Proxy that
 * swallows every call and returns inert objects. Pixels read back for the
 * "inverse alpha" / blend-mode probes come from a stub `getImageData`.
 *
 * This lets tests construct a real `Phaser.Game` and assert that the
 * game loop ticks and scenes boot — no pixels are actually rendered.
 * Browser-level render verification remains a manual `npm run dev` step.
 *
 * This module is loaded only by the **`integration`** Vitest project
 * (`vitest.config.ts`, `setupFiles`); the `unit` project runs with
 * `environment: 'node'` and never loads it. It is still a no-op when no DOM
 * globals exist (defensive, e.g. a Node-only import of a scene module).
 *
 * It also installs the **hermetic CSV fetch guard** (AH-0MVS9UEHS009QH6J,
 * parent AH-0MVKYQWSW0067F12): an un-bridged relative `/api/csv/...` fetch in
 * this project would resolve against the happy-dom origin
 * (`http://localhost:3000`) and could reach a stray dev server rooted at
 * another checkout. See `./csvFetchBridge.ts`.
 */

import { installCsvFetchGuard } from './csvFetchBridge';

const hasDom =
  typeof window !== 'undefined' &&
  typeof HTMLCanvasElement !== 'undefined' &&
  typeof HTMLImageElement !== 'undefined';

if (hasDom) {
  const contextStub = new Proxy(
    {
      canvas: null,
      getImageData: () => ({ data: new Uint8ClampedArray([255, 255, 255, 0]) }),
      measureText: () => ({ width: 0 }),
    } as Record<string | symbol, unknown>,
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        return () => ({});
      },
      set: () => true,
    },
  );

  // @ts-expect-error — intentional minimal stub, not a real rendering context.
  HTMLCanvasElement.prototype.getContext = () => contextStub;

  // Phaser sets `Features.canvas = !!window['CanvasRenderingContext2D']` at
  // import scope; without it the AUTO -> CANVAS fallback refuses to boot.
  window.CanvasRenderingContext2D = class CanvasRenderingContext2DStub {} as unknown as typeof CanvasRenderingContext2D;

  // happy-dom decodes data-URL images *synchronously*, dispatching 'load'
  // inline during `src = ...`. Real browsers load asynchronously, and Phaser
  // relies on that ordering: its TextureManager adds the default base64
  // textures before registering the SYSTEM_READY handler that creates the
  // internal `stamp` object — with synchronous loads the textures 'ready'
  // event fires first and the stamp is never created (crashing later
  // destroy()). Defer the src assignment by one microtask to restore real
  // browser ordering.
  const imageSrcDescriptor = Object.getOwnPropertyDescriptor(
    HTMLImageElement.prototype,
    'src',
  );
  if (imageSrcDescriptor?.set) {
    const originalSet = imageSrcDescriptor.set;
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      ...imageSrcDescriptor,
      set(this: HTMLImageElement, value: string) {
        queueMicrotask(() => originalSet.call(this, value));
      },
    });
  }
}

// ── Hermetic CSV fetch guard (AH-0MVS9UEHS009QH6J) ──────────────────
// Installed for every integration test file. Non-CSV requests pass straight
// through; CSV requests must use `installCsvFetchBridge(baseUrl)` (or a
// per-test `vi.stubGlobal('fetch', ...)`) and are otherwise refused with no
// network I/O.
if (typeof fetch === 'function') {
  installCsvFetchGuard();
}
