import { z } from 'zod';
import { CockpitError, type Issue } from '../shared/cockpit-error.js';
import type { Choice } from '../shared/job.js';
import { checkedArguments, type FieldOptions, issuesOf, type Job, objectSchemaOf } from './jobs.js';

/** The arguments a source sees: the others than its field's, as the schema gave them. */
type ArgsSoFar = Readonly<Record<string, unknown>>;

/** A field's source, read: how to call it, and whether its choices bind. */
interface FieldSource {
  readonly field: string;
  readonly kind: 'choices' | 'suggestions';
  readonly read: (argsSoFar: ArgsSoFar) => unknown;
}

const choices = z.array(
  z.object({
    value: z.union([z.string(), z.number(), z.boolean()]),
    label: z.string().optional(),
  }),
);

/**
 * Names the fields of a job that have an option source, for its
 * description: `choices` when a run's value must be one of them,
 * `suggestions` when any value is taken.
 *
 * @param job - The job.
 * @returns The fields with a source, in the order the job gives them; a
 * field whose source is left `undefined` has none.
 */
export function optionKindsOf(job: Job): Record<string, 'choices' | 'suggestions'> {
  return Object.fromEntries(sourcesOf(job).map(({ field, kind }) => [field, kind]));
}

/**
 * Reads a field's choices from its source, given the arguments filled so
 * far. The source sees them as the job's schema made partial gave them
 * (each filled field checked, the defaults filled in; the schema's rules
 * across fields left out, as they need every field), less its own field's:
 * a source answers here what it answers at a run.
 *
 * @param job - The job.
 * @param field - The field whose choices are read.
 * @param argsSoFar - The arguments filled so far; none when left out.
 * @returns The choices, each a value and its label, nothing more.
 * @throws `CockpitError` `invalid-arguments`, its issue at the field, for a
 * field with no source; `invalid-arguments`, with each issue, for
 * arguments so far that do not fit; `invalid-options`, its issues under
 * the job's `options`, when the source gives no list of choices. What the
 * source throws or rejects with.
 */
export async function choicesOf(
  job: Job,
  field: string,
  argsSoFar: unknown = {},
): Promise<readonly Choice[]> {
  const source = sourcesOf(job).find((each) => each.field === field);
  if (source === undefined) {
    throw new CockpitError(
      'invalid-arguments',
      `The field ${JSON.stringify(field)} of the job ${JSON.stringify(job.id)} has no option source.`,
      { issues: [{ path: [field], message: 'The field has no option source.' }] },
    );
  }
  const filled = checkedArguments(job, partialSchemaOf(job), argsSoFar) as ArgsSoFar;
  return readChoices(job, source, filled);
}

/**
 * Checks a run's values against their option sources: each field whose
 * source binds, and that the run gives a value for, has its source called
 * with the other arguments, one field after the other in the order the job
 * gives them. A field whose source only suggests takes any value.
 *
 * @param job - The job.
 * @param args - The run's arguments, as the job's schema gave them.
 * @throws `CockpitError` `not-a-choice`, with the field and the value, for
 * the first value not among its choices (values compared exactly: a number
 * is not its text); `invalid-options`, its issues under the job's
 * `options`, when a source gives no list of choices. What a source throws
 * or rejects with.
 */
export async function checkChoices(job: Job, args: unknown): Promise<void> {
  const given = args as ArgsSoFar;
  for (const source of sourcesOf(job)) {
    const value = given[source.field];
    if (source.kind === 'suggestions' || value === undefined) continue;
    const offered = await readChoices(job, source, given);
    if (!offered.some((choice) => choice.value === value)) {
      throw new CockpitError(
        'not-a-choice',
        `The value of ${JSON.stringify(source.field)} is not among its choices.`,
        { field: source.field, value },
      );
    }
  }
}

/**
 * Checks a job's option sources as it is defined: each one a function, or
 * `{ choices, suggestions: true }`, for a field of its schema.
 *
 * @param options - The job's `options`, unchecked.
 * @param fields - The fields of the job's schema; none known when the
 * schema has none, and then the fields are not checked.
 * @returns Every issue found, each path from the job.
 */
export function optionSourceIssues(
  options: unknown,
  fields: readonly string[] | undefined,
): Issue[] {
  if (options === undefined) return [];
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    return [{ path: ['options'], message: 'Expected the option sources, an object by field.' }];
  }
  return Object.entries(options).flatMap(([field, source]): Issue[] => {
    if (source === undefined) return [];
    if (!isOptionSource(source)) {
      return [
        {
          path: ['options', field],
          message:
            'Expected an option source: a function from the arguments so far to the choices, or { choices, suggestions: true }.',
        },
      ];
    }
    if (fields === undefined || fields.includes(field)) return [];
    return [
      { path: ['options', field], message: `The schema has no field ${JSON.stringify(field)}.` },
    ];
  });
}

function isOptionSource(source: unknown): boolean {
  if (typeof source === 'function') return true;
  if (typeof source !== 'object' || source === null) return false;
  const { choices: read, suggestions, ...rest } = source as Record<string, unknown>;
  return typeof read === 'function' && suggestions === true && Object.keys(rest).length === 0;
}

/** The sources of a job, as checked at `createCockpit`: a field left `undefined` has none. */
function sourcesOf(job: Job): FieldSource[] {
  // A job of any schema is a `Job`, whose options name no field it knows of.
  const options = Object.entries(job.options ?? {}) as [string, FieldOptions | undefined][];
  return options.flatMap(([field, source]): FieldSource[] => {
    if (source === undefined) return [];
    return typeof source === 'function'
      ? [{ field, kind: 'choices', read: source as FieldSource['read'] }]
      : [{ field, kind: 'suggestions', read: source.choices as FieldSource['read'] }];
  });
}

/** Calls a source with the other arguments than its field's, and checks what it gives. */
async function readChoices(job: Job, source: FieldSource, args: ArgsSoFar): Promise<Choice[]> {
  const { [source.field]: _own, ...others } = args;
  const given = choices.safeParse(await source.read(others));
  if (given.success) return given.data.map(choiceOf);
  throw new CockpitError(
    'invalid-options',
    `The option source of ${JSON.stringify(source.field)} of the job ${JSON.stringify(job.id)} gives no list of choices.`,
    {
      issues: issuesOf(given.error.issues).map(({ path, message }) => ({
        path: ['options', source.field, ...path],
        message,
      })),
    },
  );
}

/** A choice with no `label: undefined` of its own: what the wire carries. */
function choiceOf({
  value,
  label,
}: {
  value: Choice['value'];
  label?: string | undefined;
}): Choice {
  return label === undefined ? { value } : { value, label };
}

/**
 * The job's schema made partial: every field optional, its rules across
 * fields left out, as they need every field (zod refuses to make partial a
 * schema that has them).
 */
function partialSchemaOf(job: Job): z.ZodType {
  const schema = objectSchemaOf(job.args);
  if (schema === undefined)
    throw new TypeError(`The job ${JSON.stringify(job.id)} takes no object.`);
  return schema.clone({ ...schema.def, checks: [] }).partial();
}
