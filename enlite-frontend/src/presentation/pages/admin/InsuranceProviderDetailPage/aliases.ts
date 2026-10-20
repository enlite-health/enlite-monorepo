/** Lê o campo "outros nomes" da criação: separado por vírgula, sem vazios. */
export function parseAliases(raw: string): string[] {
  return raw.split(',').map((a) => a.trim()).filter((a) => a !== '');
}
