/**
 * normalizeText — minúsculo + sem diacrítico, para busca/filtro de texto no
 * cliente (`toLowerCase()` sozinho não casa "Gestión" com "gestion").
 *
 * Extraído de `SearchableSelect.tsx` (achado do gate `revisao-pr` no PR-8a,
 * 018-grupos-fixos-busca): a busca da tela de permissões
 * (`screenTreeModel.ts`) precisava do MESMO comportamento, e duplicar a
 * função em vez de compartilhar teria deixado as duas divergirem no primeiro
 * ajuste. `SearchableSelect.tsx` não migrou para este util no mesmo PR — a
 * régua do projeto é 100% de cobertura por arquivo TOCADO, e o arquivo tinha
 * (e continua tendo) 1 branch pré-existente sem cobertura (`handleOpen`,
 * `if (disabled) return`, nada a ver com a normalização) que não é dívida
 * deste PR. Migrar `SearchableSelect.tsx` para este util fica para quem
 * fechar aquela cobertura, ou para o Gabriel decidir puxar separado.
 */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}
