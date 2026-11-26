import { readFileSync } from 'node:fs';

/** An export as the API reference lists it. */
export interface DocumentedExport {
  name: string;
  kind: string;
}

/** What the API reference says of the package's surface. */
export interface ApiDocument {
  /** The export table of each entry, by entry (`.`, `./client`, …). */
  entries: Record<string, DocumentedExport[]>;
  /** The fields of each error code, by code: a field marked `?` is optional. */
  errors: Record<string, Record<string, 'required' | 'optional'>>;
}

const ENTRY_HEADING = /^### `@duongtdn\/agent-cockpit(\/[a-z-]+)?`$/;
const EXPORT_NAME = /^`([A-Za-z0-9_$]+)`$/;
const EXPORT_KIND = /^[a-z]+$/;
const ERROR_CODE = /^`([a-z-]+)`$/;
const FIELD = /`([A-Za-z]+)(\?)?`/g;

/**
 * Reads the API reference: under "Entry points", one `###` heading per entry
 * followed by a table of exports; under "Errors", one table row per code.
 */
export function readApiDocument(path: string): ApiDocument {
  const document: ApiDocument = { entries: {}, errors: {} };
  let section = '';
  let exportsOfEntry: DocumentedExport[] | undefined;

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.startsWith('## ')) {
      section = line.slice(3).trim();
      exportsOfEntry = undefined;
    } else if (section === 'Entry points' && line.startsWith('### ')) {
      exportsOfEntry = startEntry(document, line);
    } else if (section === 'Entry points' && exportsOfEntry !== undefined) {
      const [name = '', kind = ''] = cellsOf(line);
      const exportName = EXPORT_NAME.exec(name)?.[1];
      if (exportName !== undefined && EXPORT_KIND.test(kind)) {
        exportsOfEntry.push({ name: exportName, kind });
      }
    } else if (section === 'Errors') {
      const [code = '', fields = ''] = cellsOf(line);
      const errorCode = ERROR_CODE.exec(code)?.[1];
      if (errorCode !== undefined) {
        document.errors[errorCode] = Object.fromEntries(
          [...fields.matchAll(FIELD)].map(([, name, optional]) => [
            name,
            optional === undefined ? 'required' : 'optional',
          ]),
        );
      }
    }
  }
  return document;
}

function startEntry(document: ApiDocument, heading: string): DocumentedExport[] {
  const match = ENTRY_HEADING.exec(heading);
  if (match === null) throw new Error(`Not an entry's heading: ${heading}`);
  const exportsOfEntry: DocumentedExport[] = [];
  document.entries[`.${match[1] ?? ''}`] = exportsOfEntry;
  return exportsOfEntry;
}

/** The cells of a table's row, trimmed; none for a line that is no row. */
function cellsOf(line: string): string[] {
  if (!line.startsWith('|')) return [];
  return line
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((cell) => cell.trim());
}
