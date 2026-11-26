import type { Issue } from '../shared/cockpit-error.js';
import { jsonSchemaOf } from './job-descriptions.js';
import { optionSourceIssues } from './job-options.js';
import { type Job, objectSchemaOf } from './jobs.js';

/**
 * Checks a job's definition beyond its fields' kinds, as `createCockpit`
 * does: its arguments an object schema that JSON Schema can describe (the
 * browser gets it so), each option source a function or `{ choices,
 * suggestions: true }` for a field of that schema, `directory` a function,
 * `fresh` `true`.
 *
 * @param job - The job, its `args` a zod schema and its other fields
 * unchecked.
 * @returns Every issue found, each path from the job.
 */
export function jobDefinitionIssues(job: Job): Issue[] {
  const schema = objectSchemaOf(job.args);
  return [
    ...argumentIssues(job),
    ...optionSourceIssues(job.options, schema && Object.keys(schema.shape)),
    ...(job.directory === undefined || typeof job.directory === 'function'
      ? []
      : [
          { path: ['directory'], message: 'Expected a function from the arguments to the folder.' },
        ]),
    ...(job.fresh === undefined || job.fresh === true
      ? []
      : [{ path: ['fresh'], message: 'Expected true, or nothing.' }]),
  ];
}

function argumentIssues(job: Job): Issue[] {
  if (objectSchemaOf(job.args) === undefined) {
    return [
      {
        path: ['args'],
        message: "Expected an object schema (z.object(…)): its fields are the job's arguments.",
      },
    ];
  }
  try {
    jsonSchemaOf(job.args);
    return [];
  } catch (error) {
    return [
      {
        path: ['args'],
        message: `JSON Schema cannot describe the arguments, which the browser gets so: ${(error as Error).message}`,
      },
    ];
  }
}
