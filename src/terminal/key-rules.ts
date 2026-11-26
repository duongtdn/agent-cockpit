import type { KeyModifier, KeyRule } from '../shared/wire.js';

/** What a key rule reads of a keyboard event. */
export type PressedKey = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'>;

/**
 * Finds the driver's rule for a key: the one whose key is the event's and
 * whose modifiers are exactly those held.
 *
 * @param rules - The session's driver's key rules.
 * @param event - The key pressed.
 * @returns The rule; `undefined` when none matches.
 */
export function ruleForKey(rules: readonly KeyRule[], event: PressedKey): KeyRule | undefined {
  return rules.find((rule) => rule.key === event.key && sameModifiers(rule.modifiers, event));
}

function sameModifiers(modifiers: readonly KeyModifier[], event: PressedKey): boolean {
  const held: Record<KeyModifier, boolean> = {
    shift: event.shiftKey,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    meta: event.metaKey,
  };
  return (Object.keys(held) as KeyModifier[]).every(
    (modifier) => held[modifier] === modifiers.includes(modifier),
  );
}
