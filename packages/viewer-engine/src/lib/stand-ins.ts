/**
 * Stand-ins: what the page draws for a ship or object whose model did not build, most often because there is no EVE
 * data (tools-core unreachable, a machine without the game files): a cube on its ball, coloured by team, with its nose
 * face (local +Z) lit pale so the heading reads. Drawn in its own small WebGPU pass after the runtime's frame, on the
 * engine's camera, so no EVE shader or model file is involved. Without the universe file the backdrop is GREEN_SCREEN
 * (engine.ts): the runtime cannot draw into the canvas without EVE's shaders, so this pass clears the frame to it.
 *
 * Node-tested: only StandInPass touches WebGPU, and only once constructed.
 */

import type { Maybe } from '@dereekb/util';

/**
 * An sRGB colour, 0-1 per channel.
 */
export type StandInColor = readonly [number, number, number];

/**
 * The backdrop without EVE data: chroma-key green (sRGB 0, 177, 64).
 */
export const GREEN_SCREEN: readonly [number, number, number, number] = [0, 177 / 255, 64 / 255, 1];

/**
 * A ship with no team.
 */
export const NEUTRAL_STAND_IN_COLOR: StandInColor = [0.78, 0.78, 0.8];

/**
 * A static object (station, gate, structure, wreck).
 */
export const OBJECT_STAND_IN_COLOR: StandInColor = [0.45, 0.47, 0.52];

/**
 * Teams named after a colour; green is darkened to stay off the green screen.
 */
const NAMED_TEAM_COLORS: Readonly<Record<string, StandInColor>> = {
  red: [0.86, 0.2, 0.18],
  blue: [0.2, 0.42, 0.9],
  yellow: [0.95, 0.8, 0.2],
  orange: [0.95, 0.5, 0.15],
  purple: [0.6, 0.3, 0.85],
  pink: [0.95, 0.45, 0.7],
  cyan: [0.2, 0.8, 0.9],
  white: [0.95, 0.95, 0.95],
  black: [0.12, 0.12, 0.14],
  green: [0.05, 0.32, 0.12]
};

/**
 * Any other team takes one of these by a hash of its name, so a team keeps its colour across loads.
 */
const TEAM_PALETTE: readonly StandInColor[] = ['red', 'blue', 'yellow', 'purple', 'orange', 'pink', 'cyan'].map((name) => NAMED_TEAM_COLORS[name]);

/**
 * Floats per cube in the instance buffer: its model matrix (eye-relative) and colour.
 */
export const STAND_IN_FLOATS = 20;

/**
 * One cube to draw.
 */
export interface StandInCube {
  /**
   * World position, metres: the ball's centre.
   */
  readonly position: ArrayLike<number>;
  /**
   * Unit quaternion [x, y, z, w]: the ball's heading (local +Z is the nose).
   */
  readonly rotation: ArrayLike<number>;
  /**
   * The ball's radius, metres: the cube's corners touch it, so cubes overlap on screen only when the balls do.
   */
  readonly radius: number;
  /**
   * Per-axis half extents (metres, local x, y, z), in place of the radius's cube: a tracer's long thin box.
   */
  readonly halfExtents?: readonly [number, number, number];
  readonly color: StandInColor;
}

/**
 * Seconds a stand-in shot's tracer shows, from the shot's draw.
 */
export const STAND_IN_TRACER_SECONDS = 0.25;

/**
 * Seconds a hit flashes its target toward white.
 */
export const STAND_IN_HIT_FLASH_SECONDS = 0.2;

/**
 * Seconds a destroyed stand-in pops (orange, swelling) before it hides: its explosion's hide without EVE data.
 */
export const STAND_IN_DEATH_SECONDS = 1;

/**
 * How large a popping stand-in swells by the end of its pop.
 */
export const STAND_IN_DEATH_SCALE = 1.6;

/**
 * A popping stand-in's colour at the pop's start: explosion orange, fading to white.
 */
export const STAND_IN_DEATH_COLOR: StandInColor = [1, 0.55, 0.1];

/**
 * A tracer's width as a fraction of its distance from the eye: about 2 px at any zoom.
 */
export const STAND_IN_TRACER_WIDTH = 0.002;

/**
 * How far past its target a miss's tracer ends, and how far aside, in target radii.
 */
export const STAND_IN_MISS_OFFSET = 1.5;

const WHITE: StandInColor = [1, 1, 1];

/**
 * A colour mixed toward another.
 *
 * @param from - The colour at 0.
 * @param to - The colour at 1.
 * @param amount - 0-1.
 * @returns The mix.
 */
export function MixStandInColor(from: StandInColor, to: StandInColor, amount: number): StandInColor {
  const t = Math.min(1, Math.max(0, amount));
  return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t];
}

/**
 * A stand-in shot to draw: a tracer from its shooter to its target for STAND_IN_TRACER_SECONDS, and on a hit a flash on
 * its target.
 */
export interface StandInShot {
  readonly ship: string;
  readonly target: string;
  /**
   * When it drew, scene seconds.
   */
  readonly at: number;
  readonly hit: boolean;
  /**
   * Which side of its target a miss passes: from the shot's cycle parity, no RNG.
   */
  readonly side: 1 | -1;
  readonly color: StandInColor;
}

/**
 * The stand-in shots still drawing. Presentation only: never captured, cleared on a load and a time jump.
 */
export class StandInShots {
  private shots: StandInShot[] = [];

  /**
   * Adds a drawn shot.
   *
   * @param shot - The shot.
   */
  Add(shot: StandInShot): void {
    this.shots.push(shot);
  }

  /**
   * The shots whose tracers draw at `now`, after dropping those past every window.
   *
   * @param now - Scene seconds.
   * @returns The live shots.
   */
  Live(now: number): readonly StandInShot[] {
    const keep = Math.max(STAND_IN_TRACER_SECONDS, STAND_IN_HIT_FLASH_SECONDS);
    this.shots = this.shots.filter((shot) => now - shot.at < keep);
    return this.shots.filter((shot) => shot.at <= now && now - shot.at < STAND_IN_TRACER_SECONDS);
  }

  /**
   * How far through its latest hit flash a ship is.
   *
   * @param id - The ship.
   * @param now - Scene seconds.
   * @returns 0-1 through the flash; null when none shows.
   */
  FlashOf(id: string, now: number): Maybe<number> {
    let latest: Maybe<number> = null;
    for (const shot of this.shots) if (shot.hit && shot.target === id && shot.at <= now && now - shot.at < STAND_IN_HIT_FLASH_SECONDS && (latest == null || shot.at > latest)) latest = shot.at;
    return latest == null ? null : (now - latest) / STAND_IN_HIT_FLASH_SECONDS;
  }

  /**
   * How many shots it holds.
   */
  get size(): number {
    return this.shots.length;
  }

  Clear(): void {
    this.shots = [];
  }
}

export interface StandInTracerInput {
  /**
   * The shooter's drawn ball centre, world metres.
   */
  readonly from: ArrayLike<number>;
  /**
   * The target's drawn ball centre, world metres.
   */
  readonly to: ArrayLike<number>;
  /**
   * The target's ball radius, metres (a miss ends off it).
   */
  readonly targetRadius: number;
  readonly hit: boolean;
  readonly side: 1 | -1;
  /**
   * The camera's eye, world metres (the width scales with its distance).
   */
  readonly eye: ArrayLike<number>;
  /**
   * The shooter's team colour.
   */
  readonly color: StandInColor;
}

/**
 * A shot's tracer as a long thin box: from the shooter to the target (a miss past it, aside by STAND_IN_MISS_OFFSET
 * target radii), its +Z face (the pale nose) at the far end, in the shooter's colour mixed halfway to white.
 *
 * @param input - The ends, the eye and the colour.
 * @returns The box; null when the ends meet.
 */
export function StandInTracerOf(input: StandInTracerInput): Maybe<StandInCube> {
  const { from, to, targetRadius, hit, side, eye } = input;
  let end = [to[0], to[1], to[2]];
  let direction = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  let length = Math.hypot(direction[0], direction[1], direction[2]);
  if (!(length > 0)) return null;
  direction = direction.map((value) => value / length);
  if (!hit) {
    const up = Math.abs(direction[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0];
    const aside = Normalize([direction[1] * up[2] - direction[2] * up[1], direction[2] * up[0] - direction[0] * up[2], direction[0] * up[1] - direction[1] * up[0]]);
    const offset = STAND_IN_MISS_OFFSET * targetRadius;
    end = end.map((value, axis) => value + direction[axis] * offset + aside[axis] * offset * side);
    direction = [end[0] - from[0], end[1] - from[1], end[2] - from[2]];
    length = Math.hypot(direction[0], direction[1], direction[2]);
    direction = direction.map((value) => value / length);
  }
  const position = [(from[0] + end[0]) / 2, (from[1] + end[1]) / 2, (from[2] + end[2]) / 2];
  const half = (STAND_IN_TRACER_WIDTH * Math.hypot(position[0] - eye[0], position[1] - eye[1], position[2] - eye[2])) / 2;
  return { position, rotation: RotationToward(direction), radius: length / 2, halfExtents: [half, half, length / 2], color: MixStandInColor(input.color, WHITE, 0.5) };
}

/**
 * A popping stand-in's scale and colour.
 *
 * @param progress - 0-1 through the pop.
 * @returns Its scale (1 to STAND_IN_DEATH_SCALE) and colour (orange to white).
 */
export function StandInDeathPop(progress: number): { readonly scale: number; readonly color: StandInColor } {
  const t = Math.min(1, Math.max(0, progress));
  return { scale: 1 + (STAND_IN_DEATH_SCALE - 1) * t, color: MixStandInColor(STAND_IN_DEATH_COLOR, WHITE, t) };
}

/**
 * A hit stand-in's colour: white at the flash's start, back to its own by its end.
 *
 * @param color - Its own colour.
 * @param progress - 0-1 through the flash.
 * @returns The colour.
 */
export function StandInHitColor(color: StandInColor, progress: number): StandInColor {
  return MixStandInColor(WHITE, color, progress);
}

function Normalize(vector: readonly number[]): number[] {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  return length > 0 ? vector.map((value) => value / length) : [0, 0, 1];
}

/**
 * The unit quaternion turning local +Z onto a unit direction.
 */
function RotationToward(direction: readonly number[]): [number, number, number, number] {
  const [x, y, z] = direction;
  let rotation: [number, number, number, number] = [0, 1, 0, 0];
  if (z > -0.999999) {
    const w = 1 + z;
    const length = Math.hypot(-y, x, w);
    rotation = [-y / length, x / length, 0, w / length];
  }
  return rotation;
}

/**
 * Whether a ship or object of this build status draws as a cube: a stand-in (no EVE data) or a failed build.
 *
 * @param status - The ship's or object's build status.
 * @returns Whether to draw its cube.
 */
export function DrawsAsCube(status: string): boolean {
  return status === 'stand-in' || status === 'failed';
}

/**
 * A cube's colour by team: a team named after a colour takes it, any other a palette colour by its name's hash, no
 * team neutral grey.
 *
 * @param team - The ship's team.
 * @returns The colour.
 */
export function StandInTeamColor(team: Maybe<string>): StandInColor {
  const name = team?.trim().toLowerCase() ?? '';
  let color = NEUTRAL_STAND_IN_COLOR;
  if (name) {
    let hash = 0;
    for (let index = 0; index < name.length; index++) hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
    color = NAMED_TEAM_COLORS[name] ?? TEAM_PALETTE[hash % TEAM_PALETTE.length];
  }
  return color;
}

/**
 * Packs cubes for the instance buffer: per cube a column-major model matrix (rotation scaled to the half-extent, then
 * the position relative to the eye, so float32 keeps its precision far from the origin) and its colour.
 *
 * @param cubes - The cubes.
 * @param eye - The camera's eye, world metres.
 * @param out - At least `cubes.length × STAND_IN_FLOATS` floats.
 * @returns `out`.
 */
export function PackStandInCubes(cubes: readonly StandInCube[], eye: ArrayLike<number>, out: Float32Array): Float32Array {
  cubes.forEach((cube, index) => {
    const [x, y, z, w] = [cube.rotation[0], cube.rotation[1], cube.rotation[2], cube.rotation[3]];
    const half = cube.radius / Math.sqrt(3);
    const [hx, hy, hz] = cube.halfExtents ?? [half, half, half];
    const base = index * STAND_IN_FLOATS;
    // gl-matrix fromQuat, each column scaled to its axis's half-extent.
    out.set(
      [
        (1 - 2 * (y * y + z * z)) * hx,
        2 * (x * y + z * w) * hx,
        2 * (x * z - y * w) * hx,
        0,
        2 * (x * y - z * w) * hy,
        (1 - 2 * (x * x + z * z)) * hy,
        2 * (y * z + x * w) * hy,
        0,
        2 * (x * z + y * w) * hz,
        2 * (y * z - x * w) * hz,
        (1 - 2 * (x * x + y * y)) * hz,
        0,
        cube.position[0] - eye[0],
        cube.position[1] - eye[1],
        cube.position[2] - eye[2],
        1,
        cube.color[0],
        cube.color[1],
        cube.color[2],
        1
      ],
      base
    );
  });
  return out;
}

/**
 * The view-projection for eye-relative positions: projection × the view's rotation (its translation dropped).
 *
 * @param view - The view matrix, column-major.
 * @param projection - The projection matrix, column-major.
 * @param out - 16 floats.
 * @returns `out`.
 */
export function StandInViewProjection(view: ArrayLike<number>, projection: ArrayLike<number>, out: Float32Array): Float32Array {
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        const rotation = column === 3 ? (k === 3 ? 1 : 0) : k === 3 ? 0 : view[column * 4 + k];
        sum += projection[k * 4 + row] * rotation;
      }
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

/**
 * Cube faces from the vertex index (6 faces × 2 triangles), instanced per cube; the nose face (local +Z, face 4) is
 * lit pale. The light falls from above and to one side, with enough ambient that no face goes black.
 */
const STAND_IN_SHADER = /* wgsl */ `
struct Frame {
  viewProjection: mat4x4<f32>,
  light: vec4<f32>,
};

struct Cube {
  model: mat4x4<f32>,
  color: vec4<f32>,
};

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> cubes: array<Cube>;

var<private> NORMALS: array<vec3<f32>, 6> = array<vec3<f32>, 6>(
  vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(-1.0, 0.0, 0.0),
  vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(0.0, -1.0, 0.0),
  vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(0.0, 0.0, -1.0)
);

var<private> QUAD: array<vec2<f32>, 6> = array<vec2<f32>, 6>(
  vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
  vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0)
);

struct Varyings {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec3<f32>,
};

@vertex
fn vertexMain(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> Varyings {
  let face = vertex / 6u;
  let corner = QUAD[vertex % 6u];
  let normal = NORMALS[face];
  let tangent = normal.yzx;
  let bitangent = cross(normal, tangent);
  let cube = cubes[instance];
  let world = cube.model * vec4<f32>(normal + corner.x * tangent + corner.y * bitangent, 1.0);
  let worldNormal = normalize((cube.model * vec4<f32>(normal, 0.0)).xyz);
  var color = cube.color.rgb;
  if (face == 4u) {
    color = mix(color, vec3<f32>(1.0), 0.65);
  }
  var out: Varyings;
  out.position = frame.viewProjection * world;
  out.color = color * (0.4 + 0.6 * max(dot(worldNormal, frame.light.xyz), 0.0));
  return out;
}

@fragment
fn fragmentMain(in: Varyings) -> @location(0) vec4<f32> {
  return vec4<f32>(in.color, 1.0);
}
`;

/**
 * Where the light comes from (world, unit): above, and off to one side so neighbouring faces differ.
 */
const LIGHT_DIRECTION = [0.36, 0.83, 0.42] as const;

/**
 * The pass's inputs for one frame.
 */
export interface StandInFrame {
  /**
   * The frame's swap-chain image; the cubes draw over it.
   */
  readonly target: GPUTexture;
  /**
   * Clears the image to this colour first (the green screen, when the runtime drew nothing); null keeps what the
   * runtime drew.
   */
  readonly backdrop: Maybe<readonly number[]>;
  readonly cubes: readonly StandInCube[];
  readonly eye: ArrayLike<number>;
  readonly view: ArrayLike<number>;
  readonly projection: ArrayLike<number>;
}

/**
 * The WebGPU half: one pipeline, a uniform for the camera and light, a growing instance buffer and its own depth
 * buffer (the runtime's is not shared, so cubes sort among themselves and draw over whatever the runtime drew).
 */
export class StandInPass {
  private readonly device: GPUDevice;
  private readonly pipeline: GPURenderPipeline;
  private readonly frame: GPUBuffer;
  private readonly frameData = new Float32Array(20);
  private instances: Maybe<GPUBuffer> = null;
  private instanceData = new Float32Array(0);
  private bindGroup: Maybe<GPUBindGroup> = null;
  private depth: Maybe<GPUTexture> = null;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    const module = device.createShaderModule({ label: 'stand-in cubes', code: STAND_IN_SHADER });
    this.pipeline = device.createRenderPipeline({
      label: 'stand-in cubes',
      layout: 'auto',
      vertex: { module, entryPoint: 'vertexMain' },
      fragment: { module, entryPoint: 'fragmentMain', targets: [{ format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' }
    });
    this.frame = device.createBuffer({ label: 'stand-in frame', size: this.frameData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /**
   * Draws the cubes over the frame.
   *
   * @param frame - The target, the cubes and the camera.
   */
  Draw({ target, backdrop, cubes, eye, view, projection }: StandInFrame): void {
    const { device } = this;
    this.Reserve(cubes.length);
    StandInViewProjection(view, projection, this.frameData);
    this.frameData.set(LIGHT_DIRECTION, 16);
    device.queue.writeBuffer(this.frame, 0, this.frameData);
    PackStandInCubes(cubes, eye, this.instanceData);
    device.queue.writeBuffer(this.instances as GPUBuffer, 0, this.instanceData, 0, cubes.length * STAND_IN_FLOATS);
    const depth = this.Depth(target.width, target.height);
    const encoder = device.createCommandEncoder({ label: 'stand-in cubes' });
    const pass = encoder.beginRenderPass({
      label: 'stand-in cubes',
      colorAttachments: [backdrop ? { view: target.createView(), loadOp: 'clear', clearValue: { r: backdrop[0], g: backdrop[1], b: backdrop[2], a: 1 }, storeOp: 'store' } : { view: target.createView(), loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' }
    });
    if (cubes.length > 0) {
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.bindGroup as GPUBindGroup);
      pass.draw(36, cubes.length);
    }
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  /**
   * Grows the instance buffer (and its bind group) to hold `count` cubes.
   */
  private Reserve(count: number): void {
    if (this.instances && this.instanceData.length >= count * STAND_IN_FLOATS) return;
    const capacity = Math.max(64, 2 ** Math.ceil(Math.log2(Math.max(1, count))));
    this.instances?.destroy();
    this.instanceData = new Float32Array(capacity * STAND_IN_FLOATS);
    this.instances = this.device.createBuffer({ label: 'stand-in cubes', size: this.instanceData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.bindGroup = this.device.createBindGroup({
      label: 'stand-in cubes',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.frame } },
        { binding: 1, resource: { buffer: this.instances } }
      ]
    });
  }

  /**
   * The depth buffer at the target's size, recreated when it changes.
   */
  private Depth(width: number, height: number): GPUTexture {
    let depth = this.depth;
    if (!depth || depth.width !== width || depth.height !== height) {
      depth?.destroy();
      depth = this.device.createTexture({ label: 'stand-in depth', size: { width, height }, format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });
      this.depth = depth;
    }
    return depth;
  }
}
