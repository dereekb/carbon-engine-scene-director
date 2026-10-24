/**
 * A tiny program outside the page that picks one ship's stance: a controller on the hub's WebSocket (the raw protocol,
 * sd-piloting's `controller` sub-doc) that reads get_overview once a second and switches the ship's own stance with
 * order_ship by a simple rule. The page's pilot flies the stance every tick; this only chooses which one.
 *
 *   node dist/apps/scene-director/pilot-loop.js --ship <id> [--port 5520]
 *
 * The rule, in order: a ship away (warping, arriving, destroyed) is left alone; a ship that fits remote repairers (a
 * friend on its overview reports `repairs`) supports; with no hostile on its overview the stance is left alone; under
 * half HP it kites; else it brawls while it out-trades its focus up close (the envelope's out DPS within 2.5 km beats
 * the in DPS there by 10 %) and kites while it loses that trade. A switch waits 10 s after the last one, and a ship a
 * raw order holds (`manual`) is left to whoever gave it. Each tick's decision prints to stdout (this is not the MCP
 * process); errors go to stderr. The stance stays on the ship when the loop stops.
 */

import type { Maybe } from '@dereekb/util';
import type { ShipOverview, ShipOverviewRow } from '@scene-director/scene';

const HUB_PORT = 5520;
const TICK_MS = 1000;
const SWITCH_WAIT_MS = 10000;
const CLOSE_RANGE = 2500;
const KITE_UNDER_HEALTH = 0.5;
const OUT_TRADES_BY = 1.1;

type PickedStance = 'kite' | 'brawl' | 'support';

/**
 * get_overview's stance block: the resolved stance and the page pilot's report on it.
 */
interface OverviewStance {
  readonly type: string;
  readonly state?: string;
  readonly pending?: { readonly type: string };
}

interface ResultMessage {
  readonly type?: string;
  readonly id?: number;
  readonly ok?: boolean;
  readonly value?: unknown;
  readonly error?: { readonly message?: string; readonly problems?: readonly string[] };
}

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface Pick {
  /**
   * The stance to fly, or null to leave it as it is.
   */
  readonly stance: Maybe<PickedStance>;
  readonly why: string;
}

interface Trade {
  readonly on: string;
  readonly where: string;
  readonly out: number;
  readonly in: number;
}

/**
 * One controller connection to the hub: `hello` once, then `call` messages answered by `result` messages with the same
 * id.
 */
class Controller {
  private readonly ws: WebSocket;
  private readonly pending = new Map<number, PendingCall>();
  private nextId = 1;

  private constructor(ws: WebSocket, onClose: () => void) {
    this.ws = ws;
    ws.addEventListener('message', (event) => this.Receive(event.data));
    ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('the hub connection closed'));
      this.pending.clear();
      onClose();
    });
  }

  /**
   * Connects to the hub and says hello as a controller.
   *
   * @param url - The hub's WebSocket URL.
   * @param onClose - Called when the hub closes the connection.
   * @returns The open controller.
   */
  static Open(url: string, onClose: () => void): Promise<Controller> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener(
        'open',
        () => {
          ws.send(JSON.stringify({ type: 'hello', role: 'controller' }));
          resolve(new Controller(ws, onClose));
        },
        { once: true }
      );
      ws.addEventListener('error', () => reject(new Error(`cannot reach the hub at ${url} (start it with scene-director serve, or an MCP client's scene-director mcp)`)), { once: true });
    });
  }

  /**
   * Runs one tool through the hub (a page tool goes to the newest tab).
   *
   * @param name - Tool name.
   * @param args - Tool arguments.
   * @returns The tool's value.
   */
  Call<T>(name: string, args: object): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.ws.send(JSON.stringify({ type: 'call', id, name, args }));
    });
  }

  Close(): void {
    this.ws.close();
  }

  private Receive(data: unknown): void {
    let message: Maybe<ResultMessage> = null;
    try {
      message = JSON.parse(String(data)) as ResultMessage;
    } catch {
      return;
    }
    if (message?.type !== 'result' || message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.value);
    else pending.reject(new Error([message.error?.message ?? 'the hub reported an error', ...(message.error?.problems ?? [])].join('; ')));
  }
}

/**
 * The value after a command-line flag.
 *
 * @param name - The flag.
 * @param fallback - Returned when the flag is absent.
 * @returns The flag's value or the fallback.
 */
function Option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : (process.argv[index + 1] ?? fallback);
}

function Delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function Percent(fraction: number): string {
  return `${Math.round(fraction * 100)} %`;
}

function Mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * The trade up close: the envelope's mean out and in DPS within CLOSE_RANGE on its focus, else the nearest hostile's
 * row as it stands.
 *
 * @param overview - The ship's overview.
 * @param nearest - Its nearest hostile row.
 * @returns Who the trade is with, where, and the DPS each way.
 */
function CloseTrade(overview: ShipOverview, nearest: ShipOverviewRow): Trade {
  const envelope = overview.envelope;
  const close = envelope?.points?.filter((point) => point.range <= CLOSE_RANGE) ?? [];
  return envelope && close.length
    ? { on: envelope.focus, where: `within ${CLOSE_RANGE / 1000} km`, out: Mean(close.map((point) => point.out)), in: Mean(close.map((point) => point.in)) }
    : { on: nearest.id, where: `at ${(nearest.distance / 1000).toFixed(1)} km`, out: nearest.outgoingDps ?? 0, in: nearest.incomingDps ?? 0 };
}

/**
 * The rule: which stance the ship should fly on this overview.
 *
 * @param overview - The ship's overview.
 * @returns The stance, or null to leave it, and why.
 */
function PickStance(overview: ShipOverview): Pick {
  const self = overview.ship;
  const nearest = overview.rows.find((row) => row.relation === 'hostile');
  let pick: Pick;
  if (self.away) pick = { stance: null, why: 'it is away (warping, arriving or destroyed)' };
  else if (overview.rows.some((row) => row.relation === 'friendly' && row.repairs !== undefined)) pick = { stance: 'support', why: 'it fits remote repairers' };
  else if (!nearest) pick = { stance: null, why: 'no hostile on its overview' };
  else if (self.health < KITE_UNDER_HEALTH) pick = { stance: 'kite', why: `its HP is under ${Percent(KITE_UNDER_HEALTH)}` };
  else {
    const trade = CloseTrade(overview, nearest);
    const numbers = `${trade.where}: out ${trade.out.toFixed(0)} / in ${trade.in.toFixed(0)} dps`;
    if (trade.out >= trade.in * OUT_TRADES_BY) pick = { stance: 'brawl', why: `it out-trades ${trade.on} up close (${numbers})` };
    else if (trade.in > trade.out) pick = { stance: 'kite', why: `it loses the trade with ${trade.on} up close (${numbers})` };
    else pick = { stance: null, why: `an even trade with ${trade.on} up close (${numbers})` };
  }
  return pick;
}

const ship = Option('--ship', '');
if (!ship) {
  console.error('usage: node dist/apps/scene-director/pilot-loop.js --ship <id> [--port 5520]');
  process.exit(2);
}
const url = `ws://127.0.0.1:${Number(Option('--port', String(HUB_PORT)))}/ws`;
const started = Date.now();
let switchedAt = Number.NEGATIVE_INFINITY;

const controller = await Controller.Open(url, () => {
  console.error('the hub closed the connection');
  process.exit(1);
}).catch((error: unknown) => {
  console.error(ErrorText(error));
  process.exit(1);
});
process.on('SIGINT', () => {
  controller.Close();
  process.exit(0);
});

/**
 * One tick: read the overview, pick a stance, switch to it when it differs from the one the ship flies.
 */
async function Tick(): Promise<void> {
  const clock = `[${String(Math.round((Date.now() - started) / 1000)).padStart(4)} s]`;
  let overview: ShipOverview;
  try {
    overview = await controller.Call<ShipOverview>('get_overview', { ship, envelope: true });
  } catch (error) {
    console.error(`${clock} get_overview: ${ErrorText(error)}`);
    return;
  }
  const stance: Maybe<OverviewStance> = overview.stance;
  const flying = stance?.pending?.type ?? stance?.type ?? 'in-line';
  const state = stance?.state ? ' (' + stance.state + ')' : '';
  const line = `${clock} ${ship} ${flying}${state}, HP ${Percent(overview.ship.health)}`;
  const { stance: wanted, why } = PickStance(overview);
  if (stance?.state === 'manual') console.log(`${line}: leave it, a raw order holds it (${why})`);
  else if (!wanted || wanted === flying) console.log(`${line}: keep, ${why}`);
  else if (Date.now() - switchedAt < SWITCH_WAIT_MS) console.log(`${line}: wait to switch to ${wanted}, ${why}`);
  else {
    try {
      await controller.Call('order_ship', { id: ship, order: { type: 'stance', set: { type: wanted } } });
      switchedAt = Date.now();
      console.log(`${line}: switch to ${wanted}, ${why}`);
    } catch (error) {
      console.error(`${line}: order_ship refused the ${wanted} stance: ${ErrorText(error)}`);
    }
  }
}

for (;;) {
  const tickStarted = Date.now();
  await Tick();
  await Delay(Math.max(0, TICK_MS - (Date.now() - tickStarted)));
}
