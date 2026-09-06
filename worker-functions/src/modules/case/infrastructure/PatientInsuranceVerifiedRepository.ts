/**
 * PatientInsuranceVerifiedRepository — a `Cobertura Verificada` MÚLTIPLA (Fase 3, D-D).
 *
 * ── Por que existe ──────────────────────────────────────────────────────────
 * `patients.insurance_verified` é `TEXT` escalar desde a migration 037, e o campo vivo no
 * ClickUp é `labels` com **33 opções**. Medido: **345 de 349** pacientes têm cobertura lá e
 * **ZERO** aqui (F5/F7) — o mapper nunca leu o campo. É a maior lacuna medida da change.
 *
 * ── O que este arquivo herda da Fase 2, e o que NÃO herda ───────────────────
 * Herda o desenho de `PatientSourceLabelRepository`: união discriminada na entrada
 * (`readable`), substituição do conjunto inteiro por transação, e a regra dura de que
 * **"não consegui ler" nunca vira "está vazio"** (D167/F41).
 *
 * NÃO herda o teto de 3. Ali o teto veio do D-C, uma decisão de produto sobre segmento
 * clínico. Aqui o limite é o **catálogo**, que tem 33 opções e muda **sem migration** —
 * chumbar 33 no banco criaria uma régua que envelhece em silêncio, que é exatamente a classe
 * de defeito da D179. O que o banco garante é ordinal positivo e rótulo não-vazio; quantas
 * opções existem é pergunta para o catálogo.
 *
 * ⚠️ C1 do parecer do `lex`: nada aqui emite rótulo em log. Sai nome de campo e CONTAGEM.
 * ⚠️ C-D: `raw_label` NÃO sai em rota de API, export ou tela sem novo parecer.
 */

import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import type { PatientSourceLabelsRead } from './PatientSourceLabelRepository';

export interface PatientInsuranceVerifiedWriteInput {
  patientId: string;
  /** A LEITURA da origem — não uma lista. `readable:false` não escreve e não apaga. */
  read: PatientSourceLabelsRead;
  source?: string;
}

/** `written` = conjunto substituído. `skipped-unreadable` = nada foi tocado. */
export type PatientInsuranceVerifiedOutcome = 'written' | 'skipped-unreadable';

export interface PatientInsuranceVerifiedResult {
  outcome: PatientInsuranceVerifiedOutcome;
  /** Quantos itens a origem mandou, antes de qualquer filtro. */
  received: number;
  /** Os rótulos persistidos, na ordem em que ficaram (ordinal 1..N). */
  accepted: string[];
  /** Recusados por serem em branco ou duplicados — com o MOTIVO, nunca em silêncio. */
  rejected: Array<{ reason: 'blank' | 'duplicate' }>;
}

export interface PatientInsuranceVerifiedRow {
  patientId: string;
  ordinal: number;
  rawLabel: string;
  source: string;
}

/**
 * Lista de PERMISSÃO, e não de bloqueio (C5 do parecer): entra `string` com conteúdo.
 * Número, `false`, `[]`, `{}` e string em branco são DESCARTADOS com motivo — a API do
 * ClickUp já devolveu todos esses onde se esperava rótulo.
 *
 * Duplicata é recusa, não deduplicação silenciosa: o índice único do banco recusaria de
 * qualquer forma, e recusar aqui com motivo é o que faz a contagem bater.
 */
export function classifyInsuranceLabels(labels: readonly unknown[]): {
  accepted: string[];
  rejected: Array<{ reason: 'blank' | 'duplicate' }>;
} {
  const accepted: string[] = [];
  const rejected: Array<{ reason: 'blank' | 'duplicate' }> = [];
  const vistos = new Set<string>();
  for (const l of labels) {
    if (typeof l !== 'string' || l.trim() === '') { rejected.push({ reason: 'blank' }); continue; }
    if (vistos.has(l)) { rejected.push({ reason: 'duplicate' }); continue; }
    vistos.add(l);
    accepted.push(l);
  }
  return { accepted, rejected };
}

/** Código fora do catálogo ATIVO de `insurance_providers` (spec 012, US-B3) — o controller devolve 422. */
export class InsuranceProviderUnknownError extends Error {
  readonly code = 'INSURANCE_PROVIDER_UNKNOWN';
  constructor(readonly codes: string[]) {
    super(`Unknown insurance provider code(s): ${codes.join(', ')}`);
    this.name = 'InsuranceProviderUnknownError';
  }
}

/**
 * Ordinal a partir do qual o PAINEL grava (spec 012). O sync usa 1..N; separar as faixas é o que
 * evita colisão na PK (patient_id, ordinal) quando as duas origens coexistem numa ficha.
 */
export const PANEL_ORDINAL_BASE = 1000;

export class PatientInsuranceVerifiedRepository {
  private pool: Pool;
  constructor() { this.pool = DatabaseConnection.getInstance().getPool(); }

  /** ConceptMap rótulo → código, lido do BANCO a cada escrita (o catálogo muda sem deploy). */
  private async aliasMap(cli: PoolClient): Promise<Map<string, string>> {
    const r = await cli.query<{ label: string; code: string }>(
      `SELECT a.label, a.code FROM insurance_provider_aliases a
         JOIN insurance_providers p ON p.code = a.code
        WHERE a.source = 'clickup'`);
    return new Map(r.rows.map(x => [x.label, x.code]));
  }

  /**
   * Substitui o conjunto de coberturas de UM paciente.
   *
   * É o caminho do sync: a origem manda a lista inteira a cada tarefa, então o estado
   * persistido reflete a lista ATUAL — não acumula. Idempotente: rodar duas vezes com a
   * mesma lista deixa exatamente as mesmas linhas.
   *
   * NÃO APAGA quando a origem não pôde ser lida: `read.readable === false` devolve
   * `skipped-unreadable` sem tocar em nada. Um rename do campo no ClickUp não pode esvaziar
   * a cobertura de 345 pacientes com log verde.
   */
  async replaceForPatient(
    input: PatientInsuranceVerifiedWriteInput,
    client?: PoolClient,
  ): Promise<PatientInsuranceVerifiedResult> {
    const source = input.source ?? 'clickup';

    if (!input.read.readable) {
      // C1: nome do campo e motivo estrutural. Nenhum rótulo, nenhum paciente.
      console.warn('[PatientInsuranceVerifiedRepository] origem ILEGÍVEL — nada gravado e nada apagado (D167/F41):', {
        field: 'Cobertura Verificada', reason: input.read.reason,
      });
      return { outcome: 'skipped-unreadable', received: 0, accepted: [], rejected: [] };
    }

    const { accepted, rejected } = classifyInsuranceLabels(input.read.labels);
    const proprio = !client;
    const cli = client ?? await this.pool.connect();
    try {
      if (proprio) await cli.query('BEGIN');
      // Lock consultivo pelo paciente: dois syncs simultâneos do mesmo paciente não
      // intercalam DELETE e INSERT, que é como nasce conjunto pela metade.
      await cli.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`insurance:${input.patientId}`]);
      // Spec 012: o código canônico vai JUNTO do cru (migration 312), traduzido pelo ConceptMap no
      // momento da escrita — NULL quando o rótulo ainda não tem alias (nada se perde: o cru fica).
      const aliases = await this.aliasMap(cli);
      // Apaga SÓ as linhas desta origem: o que o painel gravou (source='admin_manual') sobrevive ao
      // próximo webhook — a mesma lição do QA 🔴1 do bloco A (replaceBySource dos responsáveis).
      await cli.query('DELETE FROM patient_insurance_verified WHERE patient_id = $1 AND source = $2', [input.patientId, source]);
      for (let i = 0; i < accepted.length; i++) {
        await cli.query(
          `INSERT INTO patient_insurance_verified (patient_id, ordinal, raw_label, source, provider_code)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (patient_id, raw_label) DO NOTHING`,
          [input.patientId, i + 1, accepted[i], source, aliases.get(accepted[i]) ?? null]);
      }
      if (proprio) await cli.query('COMMIT');
    } catch (err) {
      if (proprio) await cli.query('ROLLBACK');
      throw err;
    } finally {
      if (proprio) cli.release();
    }

    if (rejected.length > 0) {
      // C1: contagem por motivo. O rótulo recusado NÃO sai.
      const porMotivo = rejected.reduce<Record<string, number>>((a, r) => {
        a[r.reason] = (a[r.reason] ?? 0) + 1; return a;
      }, {});
      console.warn('[PatientInsuranceVerifiedRepository] cobertura(s) recusada(s):', {
        field: 'Cobertura Verificada', received: input.read.labels.length,
        accepted: accepted.length, byReason: porMotivo,
      });
    }

    return { outcome: 'written', received: input.read.labels.length, accepted, rejected };
  }

  /**
   * O drawer "Cobertura Médica" grava por CÓDIGO (spec 012, US-B3): substitui o conjunto que o
   * PAINEL gravou (source='admin_manual'); as linhas do sync do ClickUp não são tocadas.
   *   - código fora do catálogo ativo → InsuranceProviderUnknownError (422), sem escrever;
   *   - `raw_label` = o próprio código (é o literal escolhido na tela);
   *   - ordinal a partir de PANEL_ORDINAL_BASE; `ON CONFLICT (patient_id, raw_label) DO NOTHING`
   *     quando o ClickUp já trouxe a mesma cobertura com o mesmo literal.
   */
  async replaceCodesForPatient(
    patientId: string,
    codes: readonly string[],
    client?: PoolClient,
  ): Promise<{ codes: string[] }> {
    const wanted = Array.from(new Set(codes));
    const proprio = !client;
    const cli = client ?? await this.pool.connect();
    try {
      if (proprio) await cli.query('BEGIN');
      const catalogo = await cli.query<{ code: string }>('SELECT code FROM insurance_providers WHERE active');
      const ativos = new Set(catalogo.rows.map(r => r.code));
      const desconhecidos = wanted.filter(c => !ativos.has(c));
      if (desconhecidos.length > 0) throw new InsuranceProviderUnknownError(desconhecidos);

      await cli.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`insurance:${patientId}`]);
      await cli.query('DELETE FROM patient_insurance_verified WHERE patient_id = $1 AND source = $2', [patientId, 'admin_manual']);
      for (let i = 0; i < wanted.length; i++) {
        await cli.query(
          `INSERT INTO patient_insurance_verified (patient_id, ordinal, raw_label, source, provider_code)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (patient_id, raw_label) DO NOTHING`,
          [patientId, PANEL_ORDINAL_BASE + i, wanted[i], 'admin_manual', wanted[i]]);
      }
      if (proprio) await cli.query('COMMIT');
      return { codes: wanted };
    } catch (err) {
      if (proprio) await cli.query('ROLLBACK');
      throw err;
    } finally {
      if (proprio) cli.release();
    }
  }

  /** Os CÓDIGOS distintos do paciente (qualquer origem), na ordem do catálogo — o que a ficha mostra. */
  async findCodesByPatientId(patientId: string): Promise<string[]> {
    const r = await this.pool.query<{ provider_code: string }>(
      `SELECT DISTINCT piv.provider_code, p.sort_order
         FROM patient_insurance_verified piv
         JOIN insurance_providers p ON p.code = piv.provider_code
        WHERE piv.patient_id = $1 AND piv.provider_code IS NOT NULL
        ORDER BY p.sort_order, piv.provider_code`, [patientId]);
    return r.rows.map(x => x.provider_code);
  }

  /** Leitura interna. ⚠️ C-D: não expor `rawLabel` em rota de API sem novo parecer do `lex`. */
  async findByPatientId(patientId: string): Promise<PatientInsuranceVerifiedRow[]> {
    const r = await this.pool.query<{ patient_id: string; ordinal: number; raw_label: string; source: string }>(
      `SELECT patient_id, ordinal, raw_label, source FROM patient_insurance_verified
        WHERE patient_id = $1 ORDER BY ordinal`, [patientId]);
    return r.rows.map(x => ({ patientId: x.patient_id, ordinal: x.ordinal, rawLabel: x.raw_label, source: x.source }));
  }

  /**
   * Suprime a cobertura de um paciente. Mesma razão da C-B do parecer do `lex` que criou
   * `purgeForPatient` na Fase 2: o `ON DELETE CASCADE` nunca dispara, porque não há hard
   * delete de paciente e não haverá (ata `2026-07-22a#REQ-04`).
   */
  async purgeForPatient(patientId: string, client?: PoolClient): Promise<number> {
    const exec = client ?? this.pool;
    const r = await exec.query('DELETE FROM patient_insurance_verified WHERE patient_id = $1', [patientId]);
    const n = r.rowCount ?? 0;
    console.info('[PatientInsuranceVerifiedRepository] cobertura suprimida com o paciente (C-B/lex):', { patientId, linhas: n });
    return n;
  }
}
