/**
 * One choice an option source gives a job's field: the value a run sends,
 * and what the person reads for it.
 */
export interface Choice {
  /** The field's value, as a run's arguments carry it. */
  readonly value: string | number | boolean;
  /** What the person reads for it; the value itself when left out. */
  readonly label?: string;
}

/**
 * A job as the browser sees it, to draw its form: what it is called, the
 * input its schema takes, and which fields have choices to offer. Never its
 * key, its prompt, its folder or its driver part, which are the server's.
 */
export interface JobDescription {
  /** The job's id, which a run names. */
  readonly id: string;
  /** What the job is called, for the person. */
  readonly title: string;
  /** What the job does, for the person. */
  readonly description?: string;
  /**
   * The job's argument schema as JSON Schema, the input it takes, each
   * field's metadata (`label`, `hint`) kept on the field.
   */
  readonly schema: Readonly<Record<string, unknown>>;
  /**
   * The fields that have an option source, by name: `choices` when a run's
   * value must be one of them, `suggestions` when any value is taken.
   * `options(jobId, field, argsSoFar)` reads them.
   */
  readonly options: Readonly<Record<string, 'choices' | 'suggestions'>>;
  /**
   * Whether a run gives the agent a prompt: `false` for a job for typing,
   * whose run starts the agent with none.
   */
  readonly hasPrompt: boolean;
}
