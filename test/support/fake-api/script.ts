/** A tool call of a scripted turn: any tool name, any input. */
export type ToolUse = {
  readonly type: 'tool_use';
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
};

/** A text block of a scripted turn. */
export type Text = { readonly type: 'text'; readonly text: string };

/** One content block of a scripted turn. */
export type TurnBlock = Text | ToolUse;

/** The token counts of an answer, under the names the Messages API gives them. */
export type Usage = {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_input_tokens: number;
  readonly cache_read_input_tokens: number;
};

/** A turn of the model: its content blocks, in order, and the usage it reports. */
export type Turn = {
  readonly kind: 'turn';
  readonly blocks: readonly TurnBlock[];
  readonly usage: Usage;
};

/** An error the API answers with instead of a turn. */
export type ApiError = {
  readonly kind: 'error';
  readonly status: number;
  readonly errorType: string;
  readonly message: string;
};

/** A turn whose stream is cut: its first events are sent, then the connection is destroyed. */
export type CutStream = {
  readonly kind: 'cut';
  readonly turn: Turn;
  readonly afterEvents: number;
};

/** A turn that starts and then waits for the test, as a model that is still generating. */
export type HeldTurn = { readonly kind: 'held'; readonly turn: Turn };

/** What a test scripts for one conversation request. */
export type ScriptedAnswer = Turn | ApiError | CutStream | HeldTurn;

/** Small enough to never matter, and not zero, so that a display of them shows something. */
const DEFAULT_USAGE: Usage = {
  input_tokens: 10,
  output_tokens: 5,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

/** The error type the API gives each status it documents. */
const ERROR_TYPES: Readonly<Record<number, string>> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  413: 'request_too_large',
  429: 'rate_limit_error',
  500: 'api_error',
  529: 'overloaded_error',
};

/** The stream's start, the first block's start and its first delta: a cut in mid-sentence. */
const CUT_INSIDE_FIRST_BLOCK = 3;

/**
 * Scripts a tool call.
 *
 * @param name - The tool's name, as the agent knows it (`Bash`, `Agent`, `mcp__server__tool`).
 * @param input - The tool's input; empty when left out.
 * @returns The block, for {@link turn}.
 */
export function toolUse(name: string, input: Readonly<Record<string, unknown>> = {}): ToolUse {
  return { type: 'tool_use', name, input };
}

/**
 * Scripts a turn of the model. Its stop reason follows from its blocks: it
 * stops for the tools when it calls one, and ends the turn otherwise.
 *
 * @param blocks - The content blocks, in order: a string is a text block, {@link toolUse} a tool call.
 * @returns The turn, with the default usage; see {@link withUsage}.
 */
export function turn(...blocks: readonly (string | ToolUse)[]): Turn {
  return {
    kind: 'turn',
    blocks: blocks.map((block) =>
      typeof block === 'string' ? { type: 'text', text: block } : block,
    ),
    usage: DEFAULT_USAGE,
  };
}

/**
 * Gives a turn the usage it reports.
 *
 * @param scripted - The turn.
 * @param usage - The counts to report; a count left out keeps its value.
 * @returns A turn with that usage; the one given is not changed.
 */
export function withUsage(scripted: Turn, usage: Partial<Usage>): Turn {
  return { ...scripted, usage: { ...scripted.usage, ...usage } };
}

/**
 * Scripts an error of the API.
 *
 * @param status - The HTTP status, such as 529, 400 or 401.
 * @param details - The error's type and message; by default the type the API
 *   gives that status (`api_error` for a status it does not document) and a
 *   message naming the double.
 * @returns The scripted error.
 */
export function apiError(
  status: number,
  details: { readonly errorType?: string; readonly message?: string } = {},
): ApiError {
  const errorType = details.errorType ?? ERROR_TYPES[status] ?? 'api_error';
  return {
    kind: 'error',
    status,
    errorType,
    message: details.message ?? `Scripted ${errorType} of the fake API`,
  };
}

/**
 * Scripts a stream that is cut: the answer starts, then the connection is
 * destroyed. A request that did not ask for a stream gets no answer at all.
 *
 * @param scripted - The turn whose stream is cut.
 * @param where - `afterEvents`: how many stream events are sent before the
 *   cut; by default the cut falls inside the first block.
 * @returns The scripted cut.
 */
export function cutStream(
  scripted: Turn,
  where: { readonly afterEvents: number } = { afterEvents: CUT_INSIDE_FIRST_BLOCK },
): CutStream {
  return { kind: 'cut', turn: scripted, afterEvents: where.afterEvents };
}

/**
 * Scripts a turn that is held: the stream starts, then waits until the test
 * releases it or the client goes away.
 *
 * @param scripted - The turn that follows the release; a short text by default.
 * @returns The scripted held turn.
 */
export function heldTurn(scripted: Turn = turn('ok')): HeldTurn {
  return { kind: 'held', turn: scripted };
}
