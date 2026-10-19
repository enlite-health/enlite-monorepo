/**
 * deriveProviderCode — o `code` de uma obra social a partir do nome (spec 058 §1.1 itens 2–3, plan §1.3). Função PURA, uma só; o `code` é
 * derivado UMA vez na criação e nunca recalculado (editar `name` não muda `code`). Sem `unaccent` no banco: a normalização é daqui.
 *
 * NFD sem marcas combinantes -> caixa alta -> toda sequência fora de [A-Z0-9] vira um `_` -> `_` das pontas sai -> começa com dígito ganha
 * o prefixo `P_` (o CHECK da 311 exige `^[A-Z][A-Z0-9_]*$`) -> vazio lança `NameNotCodifiableError` (422 `NAME_NOT_CODIFIABLE`: a tela pede o código).
 */
export class NameNotCodifiableError extends Error {
  readonly code = 'NAME_NOT_CODIFIABLE';
  constructor() {
    super('o nome não tem nenhum caractere codificável; informe o código');
    this.name = 'NameNotCodifiableError';
  }
}

export function deriveProviderCode(name: string): string {
  const upper = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  if (!/[A-Z0-9]/.test(upper)) throw new NameNotCodifiableError();
  const base = upper.replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[0-9]/.test(base) ? `P_${base}` : base;
}
