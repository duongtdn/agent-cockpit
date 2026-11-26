import {
  isCallExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isIdentifier,
  isImportDeclaration,
  isImportTypeNode,
  isLiteralTypeNode,
  isNoSubstitutionTemplateLiteral,
  isStringLiteral,
  type Node,
  type SourceFile,
  SyntaxKind,
} from 'typescript/unstable/ast';
import { API } from 'typescript/unstable/sync';

/** One place where a file names a module to load. */
export interface ModuleReference {
  /** The module specifier; when it is no literal, the expression as written. */
  text: string;
  /** Whether the specifier is a string literal, so that it can be checked. */
  literal: boolean;
}

/**
 * Reads the modules each TypeScript file names: its triple-slash references
 * (`types` names a package; `path` a file, given here as a relative path),
 * then, in the order written, static imports and re-exports,
 * `import x = require()`, `import()` types, and the calls `import()` and
 * `require()`. The files are parsed by the TypeScript compiler itself, so
 * comments and strings never count, whatever they hold.
 *
 * @param paths - The absolute paths of the files.
 * @returns The references of each file, by its path.
 */
export function readModuleReferences(paths: readonly string[]): Map<string, ModuleReference[]> {
  const compiler = new API();
  try {
    const snapshot = compiler.updateSnapshot({ openFiles: [...paths] });
    return new Map(
      paths.map((path) => {
        const sourceFile = snapshot.getDefaultProjectForFile(path)?.program.getSourceFile(path);
        if (sourceFile === undefined) throw new Error(`The compiler did not read ${path}`);
        return [path, [...referenceDirectivesOf(sourceFile), ...referencesIn(sourceFile)]];
      }),
    );
  } finally {
    compiler.close();
  }
}

function referenceDirectivesOf(sourceFile: SourceFile): ModuleReference[] {
  return [
    ...sourceFile.typeReferenceDirectives.map(({ fileName }) => fileName),
    ...sourceFile.referencedFiles.map(asRelativePath),
  ].map((text) => ({ text, literal: true }));
}

/** A `path` reference is read from the file's own folder, with or without a leading dot. */
function asRelativePath({ fileName }: { fileName: string }): string {
  return /^\.{0,2}\//.test(fileName) ? fileName : `./${fileName}`;
}

function referencesIn(node: Node): ModuleReference[] {
  const named = moduleNamedBy(node);
  const references = named === undefined ? [] : [toReference(named)];
  node.forEachChild((child) => {
    references.push(...referencesIn(child));
  });
  return references;
}

/** The expression that names a module, when the node loads one. */
function moduleNamedBy(node: Node): Node | undefined {
  if (isImportDeclaration(node) || isExportDeclaration(node)) return node.moduleSpecifier;
  if (isExternalModuleReference(node)) return node.expression;
  if (isImportTypeNode(node)) {
    return isLiteralTypeNode(node.argument) ? node.argument.literal : node.argument;
  }
  if (isCallExpression(node) && loadsAModule(node.expression)) return node.arguments[0] ?? node;
  return undefined;
}

/** Whether a call's callee is `import` or `require`. */
function loadsAModule(callee: Node): boolean {
  return (
    callee.kind === SyntaxKind.ImportKeyword || (isIdentifier(callee) && callee.text === 'require')
  );
}

function toReference(named: Node): ModuleReference {
  return isStringLiteral(named) || isNoSubstitutionTemplateLiteral(named)
    ? { text: named.text, literal: true }
    : { text: named.getText(), literal: false };
}
