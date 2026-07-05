/**
 * Raw-enum leak guard for component/page tests.
 *
 * Problem it prevents: backend enums (CAREGIVER, BOTH, SEARCHING, …) rendered
 * verbatim in the UI because a component concatenated the value without going
 * through i18n. Regression examples: required_sex 'BOTH' leaking as "BOTH",
 * and the vacancy case card showing "CASO 798 - CAREGIVER - …".
 *
 * How it works: the enum vocabulary is derived from es.json itself — every
 * ALL_CAPS translation key is, by construction, an enum value the UI knows
 * how to translate. If one of those tokens shows up verbatim in the rendered
 * DOM, some component bypassed i18n.
 *
 * Known blind spots (tradeoffs for zero false positives):
 * - Keys with <3 chars (AT, M, F) never enter the vocabulary — too short to
 *   match without flagging legitimate text.
 * - Tokens that appear verbatim inside any translated label (today: DNI, CPF,
 *   BLOQUEADO) are excluded — a leak of those specific enums is not detected.
 *   The self-test pins the core enums (CAREGIVER, BOTH, SEARCHING,
 *   AT_AND_CAREGIVER) so a future label edit can't silently unguard them.
 *
 * Safe to drop into any test that renders with the REAL i18n resources
 * (see sex-both-i18n.test.tsx for the setup pattern).
 *
 * Usage in a test:
 *   const { container } = render(<MyAdminScreen {...props} />);
 *   expectNoRawEnumLeaks(container);
 */
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';

const ENUM_KEY_RE = /^[A-Z][A-Z0-9_]{2,}$/;
const TOKEN_RE = /[A-Z][A-Z0-9_]{2,}/g;

type JsonNode = string | number | boolean | null | JsonNode[] | { [key: string]: JsonNode };

function collect(
  node: JsonNode,
  keys: Set<string>,
  labelTokens: Set<string>,
): void {
  if (typeof node === 'string') {
    for (const token of node.match(TOKEN_RE) ?? []) {
      labelTokens.add(token);
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collect(item, keys, labelTokens);
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (ENUM_KEY_RE.test(key) && typeof value === 'string') {
        keys.add(key);
      }
      collect(value, keys, labelTokens);
    }
  }
}

let cachedVocabulary: Set<string> | null = null;

/**
 * Every ALL_CAPS key in the locale files (enum values the UI can translate),
 * minus tokens that legitimately appear inside translated label text.
 */
export function buildRawEnumVocabulary(): Set<string> {
  if (cachedVocabulary) return cachedVocabulary;
  const keys = new Set<string>();
  const labelTokens = new Set<string>();
  collect(esJson as JsonNode, keys, labelTokens);
  collect(ptBRJson as JsonNode, keys, labelTokens);
  cachedVocabulary = new Set([...keys].filter((k) => !labelTokens.has(k)));
  return cachedVocabulary;
}

/** Returns the enum tokens leaking verbatim in the element's rendered text. */
export function findRawEnumLeaks(root: HTMLElement): string[] {
  const vocabulary = buildRawEnumVocabulary();
  const text = root.textContent ?? '';
  const leaks = new Set<string>();
  for (const token of text.match(TOKEN_RE) ?? []) {
    if (vocabulary.has(token)) leaks.add(token);
  }
  return [...leaks].sort();
}

/** Throws (failing the test) if any known enum value is rendered raw. */
export function expectNoRawEnumLeaks(root: HTMLElement): void {
  const leaks = findRawEnumLeaks(root);
  if (leaks.length > 0) {
    throw new Error(
      `Raw enum value(s) rendered without i18n: ${leaks.join(', ')}. ` +
        'Translate at render time, e.g. ' +
        "t(`admin....Options.${value}`, value) — see enlite-frontend/CLAUDE.md (i18n).",
    );
  }
}
