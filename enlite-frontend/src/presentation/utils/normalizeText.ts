/**
 * normalizeText — minúsculo + sem diacrítico, para busca/filtro de texto no
 * cliente (`toLowerCase()` sozinho não casa "Gestión" com "gestion").
 *
 * Util compartilhado: o Combobox (que filtra as próprias opções) e a busca da
 * tela de permissões (`screenTreeModel.ts`) usam o MESMO comportamento daqui,
 * para que as duas não divirjam no primeiro ajuste. Quem precisar de busca
 * insensível a acento no cliente importa este util em vez de duplicar a função.
 */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}
