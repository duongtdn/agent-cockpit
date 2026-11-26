// Lets Node run the package's TypeScript sources as they are, in a child
// process of a test (`node --import <this> <script>.ts`): the sources import
// each other by the `.js` name the build gives them, which this maps to the
// `.ts` file beside it when no `.js` file is there.
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
      const url = new URL(specifier, context.parentURL);
      if (!existsSync(fileURLToPath(url))) {
        return nextResolve(specifier.replace(/\.js$/, '.ts'), context);
      }
    }
    return nextResolve(specifier, context);
  },
});
