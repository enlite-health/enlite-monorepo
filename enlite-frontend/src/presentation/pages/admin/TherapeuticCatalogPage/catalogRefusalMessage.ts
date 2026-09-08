/** Fora do componente pelo lint de fast refresh (spec 017). A recusa do servidor em frase da tela — 409 (duplicado) e 400 (dado pessoal no rótulo) têm frase própria. */
export function catalogRefusalMessage(err: unknown, t: (k: string, o?: Record<string, unknown>) => string): string {
  const status = typeof err === 'object' && err !== null ? (err as { status?: number }).status : undefined;
  if (status === 409) return t('admin.therapeuticCatalog.errors.duplicate');
  if (status === 400) return t('admin.therapeuticCatalog.errors.invalidLabel');
  return err instanceof Error ? err.message : String(err);
}
