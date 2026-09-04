/**
 * IcdCode — Value Object (spec 016, "Contrato de arquitetura"). Ver __tests__/IcdCode.test.ts
 * para o porquê: resposta direta ao defeito medido na F0 (código `6A02.Z` truncado para `02.Z`
 * na tela, com o DOM correto por baixo). Um VO imutável que valida formato e expõe o valor
 * INTEIRO torna essa classe de defeito impossível em qualquer código que passe a manipular
 * `IcdCode` em vez de `string` crua.
 *
 * 🔧 F1-CORREÇÃO D7 (03/09): a regex original (`^[A-Z0-9]{1,6}(\.[A-Z0-9]{1,4})?$`) ACEITAVA
 * `02.Z` — exatamente o valor do defeito medido na F0 que este VO existe para impedir. O formato
 * abaixo foi derivado medindo os 35.692 códigos REAIS do release 2026-01 (não só os 3 exemplos
 * do relatório), agrupados por `kind`/presença de ponto/tamanho de prefixo e sufixo — ver
 * `evidencias/f1fix-D7-shape-distribution.txt`:
 *   - capítulo: 2 dígitos ("06") OU 1 letra ("V", "X") — 28 valores, sem ponto.
 *   - stem: prefixo de EXATAMENTE 4 alfanuméricos, com sufixo opcional de 1-2 alfanuméricos
 *     após um ponto ("SA0Z", "8A62.Z", "QA0A.10") — nunca 2 ou 3.
 *   - extensão (capítulo X): começa com "X", 3 a 5 caracteres depois (total 4-6), sem ponto
 *     ("XM6S30", "XE1JQ").
 * `02.Z` tem prefixo de 2 (não 4) — cai fora de toda alternativa e é REJEITADO.
 */
const ICD_CODE_PATTERN = /^([0-9]{2}|[A-Z]|[A-Z0-9]{4}(\.[A-Z0-9]{1,2})?|X[A-Z0-9]{3,5})$/;

export class InvalidIcdCodeError extends Error {
  constructor(rejected: unknown) {
    super(`Código CID-11 inválido: "${String(rejected)}"`);
    this.name = 'InvalidIcdCodeError';
  }
}

export class IcdCode {
  private constructor(private readonly full: string) {}

  /**
   * `raw` aceita `null`/`undefined` apesar do tipo `string` de quem chama de dentro do TS: dado
   * vindo de JSON solto, de uma linha do banco lida sem tipo, ou de um form não obedece o tipo
   * em runtime. Antes desta correção (D7), `raw.trim()` num `null` lançava `TypeError` cru —
   * agora é sempre `InvalidIcdCodeError`, o mesmo tipo para toda entrada inválida.
   */
  static parse(raw: string | null | undefined): IcdCode {
    if (raw === null || raw === undefined) {
      throw new InvalidIcdCodeError(raw);
    }
    const trimmed = raw.trim();
    if (!ICD_CODE_PATTERN.test(trimmed)) {
      throw new InvalidIcdCodeError(raw);
    }
    return new IcdCode(trimmed);
  }

  /** O código INTEIRO — nunca um prefixo, nunca um sufixo. */
  get value(): string {
    return this.full;
  }

  toString(): string {
    return this.full;
  }

  equals(other: IcdCode): boolean {
    return this.full === other.full;
  }
}
