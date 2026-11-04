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

/** Teto do `code` (mesmo de `providerCodeParamSchema`). */
const MAX_CODE_LENGTH = 64;

export function deriveProviderCode(name: string): string {
  const upper = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  if (!/[A-Z0-9]/.test(upper)) throw new NameNotCodifiableError();
  const base = upper.replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const prefixed = /^[0-9]/.test(base);
  const full = prefixed ? `P_${base}` : base;
  if (full.length <= MAX_CODE_LENGTH) return full;
  // Teto de 64 (as rotas `:code` e o CHECK barram mais): corta na última fronteira `_` que cabe, sem `_` final; colisão segue 409 no repositório.
  const window = full.slice(0, MAX_CODE_LENGTH + 1);
  const cut = window.lastIndexOf('_');
  return cut > (prefixed ? 1 : 0) ? window.slice(0, cut) : full.slice(0, MAX_CODE_LENGTH);
}
