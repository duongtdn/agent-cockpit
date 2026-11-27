/**
 * Every bound a test waits under, in one table, multiplied by the machine's
 * slowness factor.
 *
 * A test waits for the effect it needs, never for a time: a bound here is
 * only how long that effect may take before the test fails, saying what it
 * saw. The values are what the person's machine (20 cores) needs with room
 * to spare; a slower machine says how much slower it is in
 * `COCKPIT_TEST_SLOWNESS` (1 by default). `pnpm check:ci` and CI run at 2,
 * on fewer CPUs than the person's machine has.
 *
 * How often a wait looks again is in {@link POLL}: an interval, not a
 * bound, never scaled.
 */

/** How much slower than the person's machine this one is: `COCKPIT_TEST_SLOWNESS`, at least 1. */
export const SLOWNESS: number = slownessOf(process.env.COCKPIT_TEST_SLOWNESS);

/**
 * Reads a slowness factor.
 *
 * @param value - The variable's value; none means 1.
 * @returns The factor.
 * @throws Error when the value is not a number of at least 1: a typo must not make every wait shorter.
 */
export function slownessOf(value: string | undefined): number {
  if (value === undefined || value === '') return 1;
  const factor = Number(value);
  if (!Number.isFinite(factor) || factor < 1) {
    throw new Error(`COCKPIT_TEST_SLOWNESS must be a number of at least 1, not "${value}"`);
  }
  return factor;
}

const scaled = (ms: number): number => Math.round(ms * SLOWNESS);

/** The bounds, in milliseconds, already scaled. */
export const PATIENCE = {
  /** Something the cockpit's own code, tmux or a test double does: a screen, a file, a state. */
  condition: scaled(5_000),
  /** The real agent's next step: a hook, what it draws, a state it reaches. */
  agentStep: scaled(15_000),
  /** Many rows of a long prompt typed by the driver into the real agent's input box. */
  longPromptTyped: scaled(30_000),
  /** A whole turn of the real agent in which a person answers its dialogs. */
  agentTurnWithDialogs: scaled(45_000),
  /** The `UserPromptSubmit` that follows an Enter, before the Enter counts as lost. */
  submit: scaled(3_000),
  /** A key on a start-up dialog, taken as the screen shows, before it counts as dropped. */
  dialogKey: scaled(1_000),
  /**
   * A start-up dialog's redraw, which puts its selection back on its first
   * option: about 150 ms after it showed, seen of 2.1.332. The one bound a
   * test watches through, since no sign tells the redraw came.
   */
  dialogRedraw: scaled(500),
  /** A dialog answered, gone from the screen. */
  dialogAnswered: scaled(3_000),
  /** A process the test ended, gone. */
  exit: scaled(5_000),
  /** An example app started as its `DEMO.md` says, or a browser's step through it. */
  exampleApp: scaled(20_000),
  /** A test of real tmux, processes or sockets, whole. */
  integrationTest: scaled(15_000),
  /** A test of the real agent, whole. */
  contractTest: scaled(60_000),
  /** A test of the real agent over a long prompt, or several sessions, whole. */
  longContractTest: scaled(120_000),
  /** A measure of what a sandboxed command reaches in a mode, whole. */
  measureTest: scaled(90_000),
  /** A test in a real browser, whole. */
  browserTest: scaled(30_000),
  /** A test through an example app, whole, and its setup. */
  endToEndTest: scaled(60_000),
} as const;

/**
 * How long, in seconds, a test double takes to answer when it must not
 * answer at all: twice the longest wait of a condition, so that a wait
 * that ends is surely the code's own bound, never the double's answer.
 */
export const NEVER_S: number = Math.ceil((2 * PATIENCE.condition) / 1000);

/** How often a wait looks again, in milliseconds: not bounds, never scaled. */
export const POLL = {
  /** A condition of the cockpit's own code or of a test double. */
  condition: 20,
  /** What a terminal shows. */
  screen: 20,
  /** The hooks a receiver has read. */
  hooks: 25,
  /** Whether a session of the real agent still lives. */
  session: 50,
  /** A dialog of the real agent, which draws itself late. */
  dialog: 200,
} as const;
