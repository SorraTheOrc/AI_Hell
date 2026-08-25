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
 */
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