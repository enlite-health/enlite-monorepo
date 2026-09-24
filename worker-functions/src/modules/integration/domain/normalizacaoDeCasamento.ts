// copia literal de normalizeNameForMatch em src/modules/integration/infrastructure/anacare/AnaCareMirrorProvider.ts
export function normalizarNome(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

// reexportado de ../../../shared/utils/phoneNormalization.ts
export { toNationalAR as normalizarTelefone } from '../../../shared/utils/phoneNormalization';

// Zero a esquerda NAO e removido: dois documentos distintos poderiam colidir
// (ex.: '012345678' e '12345678'), e colisao no degrau do documento e
// exatamente o falso-positivo mais forte que o casador pode produzir.
export function normalizarDocumento(doc: string | null | undefined): string | null {
  if (doc === null || doc === undefined) return null;
  const digitos = doc.replace(/\D/g, '');
  return digitos === '' ? null : digitos;
}
