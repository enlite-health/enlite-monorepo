const ES = new Intl.Collator('es', { sensitivity: 'base', numeric: true });

/** Ordena A–Z (pt/es: acento e caixa não contam; números por valor). Devolve cópia. */
export function sortAlphabeticallyEs<T extends { label: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => ES.compare(a.label, b.label));
}
