/**
 * DiagnosisSource — Value Object (spec 016 F2, D263). A ORIGEM DE ESCRITA de uma linha de
 * `patient_diagnoses` — não confundir com `terminology_system` (o VOCABULÁRIO da linha).
 *
 * Carrega a ORDEM DE PRECEDÊNCIA (PANEL > CLICKUP > BACKFILL) que `PrimaryDiagnosisPolicy` usa
 * para decidir QUAL principal aparece na tela quando mais de uma origem tem um principal ativo
 * (a REGRA-03 do Diego, `2026-08-12a`: "o dado nasce no Postgres e vai para fora, nunca de fora
 * para dentro" — o painel nunca perde para o ClickUp, e o ClickUp nunca perde para um backfill).
 * A precedência é responsabilidade DESTE arquivo, não da migration nem do repositório — é regra
 * de domínio, não de armazenamento (a tabela grava um `is_primary` POR origem, ver migration 325).
 */

export type DiagnosisSourceValue = 'PANEL' | 'CLICKUP' | 'BACKFILL';

/** Menor número = maior precedência. */
const PRECEDENCE: Record<DiagnosisSourceValue, number> = {
  PANEL: 0,
  CLICKUP: 1,
  BACKFILL: 2,
};

export class InvalidDiagnosisSourceError extends Error {
  constructor(rejected: unknown) {
    super(`Origem de diagnóstico inválida: "${String(rejected)}"`);
    this.name = 'InvalidDiagnosisSourceError';
  }
}

export class DiagnosisSource {
  private constructor(private readonly val: DiagnosisSourceValue) {}

  static parse(raw: string | null | undefined): DiagnosisSource {
    if (raw !== 'PANEL' && raw !== 'CLICKUP' && raw !== 'BACKFILL') {
      throw new InvalidDiagnosisSourceError(raw);
    }
    return new DiagnosisSource(raw);
  }

  static readonly PANEL = new DiagnosisSource('PANEL');
  static readonly CLICKUP = new DiagnosisSource('CLICKUP');
  static readonly BACKFILL = new DiagnosisSource('BACKFILL');

  get value(): DiagnosisSourceValue {
    return this.val;
  }

  private get precedence(): number {
    return PRECEDENCE[this.val];
  }

  /** `true` quando ESTA origem vence `other` na hora de escolher qual principal exibir. */
  outranks(other: DiagnosisSource): boolean {
    return this.precedence < other.precedence;
  }

  equals(other: DiagnosisSource): boolean {
    return this.val === other.val;
  }

  toString(): string {
    return this.val;
  }
}
