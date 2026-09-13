/**
 * maskDocumentNumber — spec 018 PR-3 (`lex` #3(b), FR-210): o número do documento do contato de
 * emergência DEVE ser mascarado ANTES do render, por UMA função — o innerHTML do card nunca
 * contém o número inteiro. Últimos 3 caracteres alfanuméricos visíveis, o resto vira `•`.
 *
 * Mantém separadores (espaço/ponto/traço) já presentes, mascarando só os caracteres
 * alfanuméricos — "30.111.222" vira "••.•••.222", não "•••••••222" (a forma do documento
 * continua reconhecível, o valor não).
 */
export function maskDocumentNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const alnumCount = (raw.match(/[a-zA-Z0-9]/g) ?? []).length;
  if (alnumCount === 0) return null;
  const visibleFromIndex = Math.max(0, alnumCount - 3);
  let seen = 0;
  return raw.replace(/[a-zA-Z0-9]/g, (ch) => {
    const masked = seen < visibleFromIndex ? '•' : ch;
    seen += 1;
    return masked;
  });
}
