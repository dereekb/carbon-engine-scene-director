/**
 * The movie export's slate source (sd-export, `source: "slate"`): each frame is the timeline time on black, drawn with
 * Canvas 2D, so the whole pipeline (the clock, the encoder, the wire, the hub and the file) runs with no renderer:
 * verify-page's way through it headless.
 */

import type { Maybe } from '@dereekb/util';

export interface SlateInfo {
  readonly scene: Maybe<string>;
  /**
   * Timeline seconds of the frame.
   */
  readonly time: number;
  /**
   * The step's index (negative while prerolling) and the encoded frames.
   */
  readonly index: number;
  readonly frames: number;
  readonly tick: number;
  readonly fps: number;
}

/**
 * The slate's text lines.
 *
 * @param info - The frame.
 * @returns The scene's name, the timeline time, the frame, the tick and the fps.
 */
export function SlateLines(info: SlateInfo): string[] {
  const frame = info.index < 0 ? `preroll ${info.index}` : `frame ${info.index + 1} / ${info.frames}`;
  return [info.scene || 'scene', `timeline ${info.time.toFixed(3)} s`, frame, `tick ${info.tick}`, `fps ${info.fps}`];
}

/**
 * Draws the slate: black, the lines in white, and a bar that moves with the frame (one sweep a second).
 *
 * @param context - A 2D context on the output-sized canvas.
 * @param info - The frame.
 */
export function DrawSlate(context: OffscreenCanvasRenderingContext2D, info: SlateInfo): void {
  const { width, height } = context.canvas;
  context.fillStyle = '#000';
  context.fillRect(0, 0, width, height);
  const lines = SlateLines(info);
  const size = Math.max(8, Math.floor(height / (lines.length + 3)));
  context.fillStyle = '#fff';
  context.font = `${size}px monospace`;
  context.textBaseline = 'top';
  lines.forEach((line, index) => context.fillText(line, size, size * (index + 0.5)));
  const phase = (((info.index % info.fps) + info.fps) % info.fps) / info.fps;
  const bar = Math.max(2, Math.floor(width / 40));
  context.fillRect(Math.floor(phase * (width - bar)), height - size, bar, size);
}
