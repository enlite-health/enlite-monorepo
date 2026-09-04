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
 *
 * 🔧 F1.5-CORREÇÃO C1 (D261, parecer do CTO): D164 e D190 avisaram NOMINALMENTE que "o que se
 * guarda num campo código pode ser `XX/YY&ZZ`" (cluster pós-coordenado da OMS: `/` liga um stem
 * à sua extensão — `KA00.0/XS2R` —, `&` combina duas unidades — `6A02.Z&XS5W`). A regex original
 * só aceitava UMA unidade — a violação vivia em silêncio. `ICD_UNIT_PATTERN` é a MESMA gramática
 * de uma unidade isolada de antes (capítulo | stem | extensão); `ICD_CODE_PATTERN` aceita uma
 * unidade sozinha OU uma cadeia de unidades separadas por `/`/`&`, sempre como STRING OPACA —
 * a porta não interpreta semântica de cluster, só valida forma e preserva o valor INTEIRO
 * (mesmo requisito do defeito da F0: nunca truncar). Um membro truncado (`02.Z`) dentro do
 * cluster continua REJEITADO — `ICD_UNIT_PATTERN` é a mesma unidade de sempre, não uma unidade
 * mais permissiva.
 */
const ICD_UNIT_PATTERN = '(?:[0-9]{2}|[A-Z]|[A-Z0-9]{4}(?:\\.[A-Z0-9]{1,2})?|X[A-Z0-9]{3,5})';
const ICD_CODE_PATTERN = new RegExp(`^${ICD_UNIT_PATTERN}(?:[/&]${ICD_UNIT_PATTERN})*$`);
/** Separador de cluster pós-coordenado — usado só para derivar `.stem`, nunca na validação. */
const CLUSTER_SEPARATOR_PATTERN = /[/&]/;

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

  /**
   * C1 (D261) — o código BASE, sem extensão/cluster pós-coordenado. Para um código simples
   * (sem `/` nem `&`) é o próprio valor. `IcdCode` continua tratando o cluster como STRING
   * OPACA na validação — este getter é a única decomposição que a porta oferece, para quem
   * precisar do código base (ex.: agrupar por stem) sem reimplementar o parsing do formato OMS.
   */
  get stem(): string {
    const sepIndex = this.full.search(CLUSTER_SEPARATOR_PATTERN);
    return sepIndex === -1 ? this.full : this.full.slice(0, sepIndex);
  }

  toString(): string {
    return this.full;
  }

  equals(other: IcdCode): boolean {
    return this.full === other.full;
  }
}
