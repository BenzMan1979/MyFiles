export type Easing = (t: number) => number;

export const easeInOutCubic: Easing = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
export const easeOutCubic: Easing = (t) => 1 - Math.pow(1 - t, 3);
export const easeInCubic: Easing = (t) => t * t * t;
export const linear: Easing = (t) => t;

/** Runs `update` every frame with eased progress 0..1 over `duration` seconds. */
export function tween(duration: number, update: (t: number) => void, ease: Easing = easeInOutCubic) {
  return new Promise<void>((resolve) => {
    const start = performance.now();
    const step = (now: number) => {
      const raw = Math.min(1, (now - start) / (duration * 1000));
      update(ease(raw));
      if (raw < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export const wait = (seconds: number) => new Promise<void>((r) => setTimeout(r, seconds * 1000));
