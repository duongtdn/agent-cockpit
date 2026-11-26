// A launcher form for any job, drawn from what `client.jobs()` says of it:
// a field per property of its JSON Schema (its label, hint, type, default,
// whether it is required), a select for a field whose values come from an
// option source or an `enum`, a datalist for one that only suggests. A
// source's choices are read with `client.options(…)` from the fields before
// it, and read again whenever one of those changes.

import { showError, showPending, showResult } from './results.js';

/**
 * Draws a job's launcher: its title, what it does, its form and the line
 * where a run's result shows.
 *
 * @param job - A `JobDescription`, as `client.jobs()` gives it.
 * @param client - The cockpit client, to read choices and to run the job.
 * @returns The launcher's section, to put in the page.
 */
export function drawLauncher(job, client) {
  const section = element('section', { className: 'job' });
  section.dataset.job = job.id;
  section.setAttribute('aria-label', job.title);
  const form = element('form');
  const result = element('p', { className: 'result' });
  result.setAttribute('role', 'status');
  const fields = fieldsOf(job).map((spec) => drawField(spec));
  const fresh = element('input', { type: 'checkbox', name: 'fresh' });
  const run = element('button', { type: 'submit', textContent: 'Run' });
  form.append(
    ...fields.map((field) => field.row),
    labelled(fresh, 'Start a fresh conversation'),
    run,
  );
  section.append(element('h3', { textContent: job.title }));
  if (job.description !== undefined) {
    section.append(element('p', { className: 'description', textContent: job.description }));
  }
  if (!job.hasPrompt) {
    section.append(
      element('p', {
        className: 'description',
        textContent: 'No prompt: a run starts the agent for you to type in its terminal.',
      }),
    );
  }
  section.append(form, result);

  const choices = dependentChoices(job, fields, client, result);
  fields.forEach((field, index) => {
    field.control.addEventListener('change', () => choices.refreshAfter(index));
  });
  choices.refreshAfter(-1);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    run.disabled = true;
    showPending(result, `Running ${job.title}…`);
    try {
      const options = fresh.checked ? { fresh: true } : undefined;
      showResult(result, await client.run(job.id, valuesOf(fields), options));
      // A fresh start is asked for one run, not for every run after it.
      fresh.checked = false;
    } catch (error) {
      showError(result, error);
    } finally {
      run.disabled = false;
    }
  });
  return section;
}

/** What the form needs of each property of the job's schema, in the schema's order. */
function fieldsOf(job) {
  const required = new Set(job.schema.required ?? []);
  return Object.entries(job.schema.properties ?? {}).map(([name, property]) => ({
    id: `${job.id}-${name}`,
    name,
    property,
    required: required.has(name),
    source: job.options[name],
  }));
}

/**
 * Draws one field: its label, its control and its hint. Every control
 * gives its value through `read()` (`undefined` when it is empty), as the
 * schema's type wants it, a choice's value as the source gave it.
 */
function drawField(spec) {
  const { property } = spec;
  const field = controlFor(spec);
  const row = element('div', { className: 'field' });
  const label = element('label', { textContent: property.label ?? spec.name });
  label.htmlFor = spec.id;
  field.control.id = spec.id;
  field.control.name = spec.name;
  field.control.required = spec.required && property.type !== 'boolean';
  row.append(label, ...field.parts);
  if (property.hint !== undefined) {
    const hint = element('small', { id: `${spec.id}-hint`, textContent: property.hint });
    field.control.setAttribute('aria-describedby', hint.id);
    row.append(hint);
  }
  return { ...spec, ...field, row };
}

/** The control a field's values call for: its option source's kind first, then its schema. */
function controlFor(spec) {
  if (spec.source === 'choices') return selectField(spec, []);
  if (spec.source === 'suggestions') return suggestionsField(spec);
  if (Array.isArray(spec.property.enum)) {
    return selectField(
      spec,
      spec.property.enum.map((value) => ({ value })),
    );
  }
  if (spec.property.type === 'boolean') return checkboxField(spec);
  return inputField(spec);
}

/** A select of choices: a source's, read later, or an `enum`'s. */
function selectField(spec, initial) {
  const control = element('select');
  let shown = [];
  const field = {
    control,
    parts: [control],
    read: () => (control.value === '' ? undefined : shown[Number(control.value)]?.value),
    /** Shows choices, keeping the value chosen while it is still among them. */
    offer(choices) {
      const kept = field.read() ?? spec.property.default;
      shown = choices;
      const blank = element('option', { value: '', textContent: 'Choose…' });
      control.replaceChildren(
        blank,
        ...choices.map((choice, index) =>
          element('option', { value: String(index), textContent: choice.label ?? choice.value }),
        ),
      );
      const index = choices.findIndex((choice) => choice.value === kept);
      control.value = index === -1 ? '' : String(index);
    },
  };
  field.offer(initial);
  return field;
}

/** A text box with a datalist of suggestions: any value is taken. */
function suggestionsField(spec) {
  const control = element('input', { type: 'text', autocomplete: 'off' });
  const list = element('datalist', { id: `${spec.id}-suggestions` });
  control.setAttribute('list', list.id);
  setDefault(control, spec.property.default);
  return {
    control,
    parts: [control, list],
    read: () => textValue(control),
    offer(choices) {
      list.replaceChildren(
        ...choices.map((choice) =>
          element('option', { value: String(choice.value), label: choice.label ?? '' }),
        ),
      );
    },
  };
}

function checkboxField(spec) {
  const control = element('input', { type: 'checkbox' });
  control.checked = spec.property.default === true;
  return { control, parts: [control], read: () => control.checked };
}

function inputField(spec) {
  const numeric = spec.property.type === 'number' || spec.property.type === 'integer';
  const control = element('input', { type: numeric ? 'number' : 'text', autocomplete: 'off' });
  if (spec.property.type === 'integer') control.step = '1';
  setDefault(control, spec.property.default);
  return {
    control,
    parts: [control],
    read: () => (numeric && control.value !== '' ? Number(control.value) : textValue(control)),
  };
}

/**
 * Reads the choices of the fields with a source. A field's choices depend
 * on the fields before it: when one changes, every sourced field after it
 * is read again, one after the other (a field read again may lose its
 * value, which changes what the next one is given). A newer change stops
 * the reading under way, its answers dropped, and reads again from the
 * earlier of the two changes.
 */
function dependentChoices(job, fields, client, result) {
  let generation = 0;
  /** The earliest change whose reading has not finished; none when every field is current. */
  let unfinished = Number.POSITIVE_INFINITY;
  return {
    async refreshAfter(changed) {
      const current = ++generation;
      unfinished = Math.min(unfinished, changed);
      const from = unfinished;
      for (const [index, field] of fields.entries()) {
        if (index <= from || field.source === undefined) continue;
        field.control.setAttribute('aria-busy', 'true');
        try {
          const choices = await client.options(
            job.id,
            field.name,
            valuesOf(fields.slice(0, index)),
          );
          if (current !== generation) return;
          field.offer(choices);
        } catch (error) {
          if (current === generation) showError(result, error);
          return;
        } finally {
          if (current === generation) field.control.setAttribute('aria-busy', 'false');
        }
      }
      unfinished = Number.POSITIVE_INFINITY;
    },
  };
}

/** The values of the fields that are filled, by name. */
function valuesOf(fields) {
  return Object.fromEntries(
    fields.flatMap((field) => {
      const value = field.read();
      return value === undefined ? [] : [[field.name, value]];
    }),
  );
}

function textValue(control) {
  return control.value === '' ? undefined : control.value;
}

function setDefault(control, value) {
  if (value !== undefined) control.value = String(value);
}

function labelled(control, text) {
  const label = element('label', { className: 'option' });
  label.append(control, ` ${text}`);
  return label;
}

function element(tag, properties = {}) {
  return Object.assign(document.createElement(tag), properties);
}
