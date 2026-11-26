import { z } from 'zod';
import type { JobDescription } from '../shared/job.js';
import { optionKindsOf } from './job-options.js';
import type { Job } from './jobs.js';

/**
 * Describes a job for the browser, to draw its form: never its key, its
 * prompt, its folder, `fresh` or its driver part, which are the server's.
 *
 * @param job - A job checked at `createCockpit`, whose schema JSON Schema
 * can describe.
 * @returns The job's id, title and description, its schema as JSON Schema,
 * which fields have an option source and of which kind, and whether it has
 * a prompt.
 */
export function describeJob(job: Job): JobDescription {
  return {
    id: job.id,
    title: job.title,
    ...(job.description === undefined ? {} : { description: job.description }),
    schema: jsonSchemaOf(job.args),
    options: optionKindsOf(job),
    hasPrompt: job.prompt !== undefined,
  };
}

/**
 * Gives a job's schema as JSON Schema: the input it takes (a field with a
 * default is optional, a transformed one is the text it is given), each
 * field's metadata (`label`, `hint`) kept on the field.
 *
 * @param args - The job's argument schema.
 * @returns The JSON Schema.
 * @throws What zod throws for a schema JSON Schema cannot describe: a date,
 * a bigint, a custom type, a bare transform.
 */
export function jsonSchemaOf(args: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(args, { io: 'input', unrepresentable: 'throw' });
}
