/**
 * The channel's runtime. It is no entry of the package: the core alone imports
 * it and hands it everything it needs as arguments, so that it stays
 * separable from sessions and the terminal. It imports only the channel
 * declaration, the shared code, Node built-ins and zod.
 *
 * @packageDocumentation
 */

export {};
