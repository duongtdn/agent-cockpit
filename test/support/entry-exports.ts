import { readFileSync } from 'node:fs';

/** An export of an entry's index file. */
export interface DeclaredExport {
  name: string;
  /** Whether it exists only for the type checker. */
  typeOnly: boolean;
}

const COMMENT = /\/\*[\s\S]*?\*\/|\/\/.*$/gm;
const EXPORT_LIST = /export\s+(type\s+)?\{([^}]*)\}(?:\s*from\s*['"][^'"]+['"])?\s*;/g;

/**
 * Reads the exports of an entry's index file. An index holds only named
 * export lists (`export { a } from`, `export type { A } from`), so that what
 * an entry exposes is written out in one place; anything else throws.
 */
export function readEntryExports(path: string): DeclaredExport[] {
  const code = readFileSync(path, 'utf8').replace(COMMENT, '');
  const rest = code.replace(EXPORT_LIST, '').trim();
  if (rest !== '') {
    throw new Error(`${path} must hold only named export lists, but has: ${rest}`);
  }
  return [...code.matchAll(EXPORT_LIST)].flatMap(([, typeList, names = '']) =>
    names
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '')
      .map((item) => readExport(item, typeList !== undefined)),
  );
}

function readExport(item: string, inTypeList: boolean): DeclaredExport {
  const typeOnly = inTypeList || item.startsWith('type ');
  const name =
    item
      .replace(/^type\s+/, '')
      .split(/\s+as\s+/)
      .at(-1) ?? item;
  return { name, typeOnly };
}
