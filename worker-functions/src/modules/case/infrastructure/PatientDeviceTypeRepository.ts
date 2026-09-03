/**
 * PatientDeviceTypeRepository — o `Tipo de Dispositivo` MÚLTIPLO (Fase 4, task 4.2).
 *
 * ── O que herda da Fase 3, e o que NÃO herda ────────────────────────────────
 * Herda o desenho de `PatientInsuranceVerifiedRepository`: união discriminada na entrada
 * (`readable`), substituição do conjunto inteiro em transação, lock consultivo por paciente,
 * e a regra dura de que **"não consegui ler" nunca vira "está vazio"** (D167/F41).
 *
 * NÃO herda a aceitação livre de rótulo. Cobertura grava o rótulo cru (`raw_label`) e o limite
 * é só "não-vazio". Aqui a coluna tem **FK para `device_types(code)`** (migration 307), então
 * um valor fora do catálogo não é um dado ruim: é um **`23503` estourando no meio do webhook**.
 * Por isso este repositório traduz e valida ANTES de escrever, e o que não traduz vai para
 * QUARENTENA em `patient_source_labels` — a tabela que existe exatamente para isso, e o mesmo
 * caminho que a migration 308 usou para os valores legados.
 *
 * ── Por que não há teto ─────────────────────────────────────────────────────
 * O limite é o catálogo: a FK impede tipo inexistente, e a PK `(patient_id, device_type)`
 * impede duplicata ⇒ um paciente não pode ter mais tipos do que tipos existem. Teto numérico
 * espelhando catálogo editável vira mentira no primeiro tipo novo (migration 309).
 *
 * ⚠️ C1 do parecer do `lex`: nada aqui emite rótulo em log. Sai nome de campo e CONTAGEM.
 *    `INPATIENT` e `INSTITUTIONAL` revelam regime de cuidado — são dado de saúde.
 */

import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import type { PatientSourceLabelsRead } from './PatientSourceLabelRepository';

export interface PatientDeviceTypeWriteInput {
  patientId: string;
  /** A LEITURA da origem — não uma lista. `readable:false` não escreve e não apaga. */
  read: PatientSourceLabelsRead;
  source?: string;
}

/** `written` = conjunto substituído. `skipped-unreadable` = nada foi tocado. */
export type PatientDeviceTypeOutcome = 'written' | 'skipped-unreadable';

export interface PatientDeviceTypeResult {
  outcome: PatientDeviceTypeOutcome;
  /** Quantos itens a origem mandou, antes de qualquer filtro. */
  received: number;
  /** Os CÓDIGOS canônicos persistidos (enum em inglês), na ordem do catálogo. */
  accepted: string[];
  /** Recusados, com o MOTIVO — nunca em silêncio. `unmapped` vai para quarentena. */
  rejected: Array<{ reason: 'blank' | 'duplicate' | 'unmapped' }>;
  /** Quantos rótulos foram para quarentena em `patient_source_labels`. */
  quarantined: number;
}

export class PatientDeviceTypeRepository {
  private poolMemo?: Pool;

  /**
   * ⚠️ O pool é PREGUIÇOSO de propósito, diferente do repositório irmão da cobertura.
   *
   * O construtor do `PatientInsuranceVerifiedRepository` chama
   * `DatabaseConnection.getInstance().getPool()` na hora — e por isso qualquer suíte que
   * exercite o caminho real do webhook precisa dublar o banco só para CONSTRUIR o objeto,
   * mesmo que nenhum teste dela vá escrever. Medido ao ligar este repositório: a suíte da
   * 1.13, que roda o `handle()` real, quebrou inteira com "No database configuration found"
   * — 13 testes vermelhos por um pool que ninguém ia usar.
   *
   * Construir tem de ser barato. Quem paga a conexão é quem escreve.
   */
  private get pool(): Pool {
    this.poolMemo ??= DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  /**
   * Traduz os rótulos da origem para códigos do catálogo, pelo ConceptMap
   * (`device_type_aliases`), e separa o que não traduz.
   *
   * ⚠️ Lê o catálogo do BANCO a cada chamada, e não de uma constante em TypeScript. Um
   * `union type` aqui reintroduziria o deploy que a tabela existe para eliminar (decisão do
   * Gabriel, 25/08: catálogo editável sem deploy). O custo é uma query por sync; o benefício é
   * que criar um tipo no painel funciona no mesmo instante.
   *
   * Lista de PERMISSÃO, não de bloqueio (C5 do parecer do `lex` sobre o `asIndexable`): entra
   * `string` com conteúdo que o ConceptMap conhece. Número, `false`, `[]`, `{}` e string em
   * branco são descartados com motivo — a API do ClickUp já devolveu todos esses onde se
   * esperava rótulo.
   */
  private async classificar(
    labels: readonly unknown[],
    cli: PoolClient,
  ): Promise<{
    accepted: string[];
    rejected: Array<{ reason: 'blank' | 'duplicate' | 'unmapped' }>;
    unmappedLabels: string[];
  }> {
    const accepted: string[] = [];
    const rejected: Array<{ reason: 'blank' | 'duplicate' | 'unmapped' }> = [];
    const unmappedLabels: string[] = [];
    const vistos = new Set<string>();

    const catalogo = await cli.query<{ label: string; code: string }>(
      `SELECT a.label, a.code
         FROM device_type_aliases a
         JOIN device_types d ON d.code = a.code
        WHERE a.source = 'clickup'`,
    );
    const porRotulo = new Map(catalogo.rows.map(r => [r.label, r.code]));

    for (const l of labels) {
      if (typeof l !== 'string' || l.trim() === '') { rejected.push({ reason: 'blank' }); continue; }
      const code = porRotulo.get(l);
      if (!code) {
        // NÃO é erro do sync: é rótulo novo no ClickUp que o ConceptMap ainda não conhece.
        // Vai para quarentena e o paciente segue sendo gravado — parar o sync inteiro por um
        // rótulo novo transformaria uma edição de operação em incidente de produção.
        rejected.push({ reason: 'unmapped' });
        unmappedLabels.push(l);
        continue;
      }
      if (vistos.has(code)) { rejected.push({ reason: 'duplicate' }); continue; }
      vistos.add(code);
      accepted.push(code);
    }
    return { accepted, rejected, unmappedLabels };
  }

  /**
   * Substitui o conjunto de tipos de dispositivo de UM paciente.
   *
   * O escalar `patients.device_type` **não é tocado aqui**: o trigger da migration 310 o
   * recalcula a partir desta tabela. Escrever os dois seria o dual-write que a F64 mediu.
   *
   * NÃO APAGA quando a origem não pôde ser lida: `read.readable === false` devolve
   * `skipped-unreadable` sem tocar em nada.
   */
  async replaceForPatient(
    input: PatientDeviceTypeWriteInput,
    client?: PoolClient,
  ): Promise<PatientDeviceTypeResult> {
    const source = input.source ?? 'clickup';

    if (!input.read.readable) {
      // C1: nome do campo e motivo estrutural. Nenhum rótulo, nenhum paciente.
      console.warn('[PatientDeviceTypeRepository] origem ILEGÍVEL — nada gravado e nada apagado (D167/F41):', {
        field: 'Tipo de Dispositivo', reason: input.read.reason,
      });
      return { outcome: 'skipped-unreadable', received: 0, accepted: [], rejected: [], quarantined: 0 };
    }

    const proprio = !client;
    const cli = client ?? await this.pool.connect();
    let accepted: string[] = [];
    let rejected: Array<{ reason: 'blank' | 'duplicate' | 'unmapped' }> = [];
    let quarantined = 0;
    try {
      if (proprio) await cli.query('BEGIN');
      // Lock consultivo pelo paciente: dois syncs simultâneos do mesmo paciente não intercalam
      // DELETE e INSERT, que é como nasce conjunto pela metade — e aqui isso dispararia o
      // trigger sobre um estado intermediário.
      await cli.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`device_type:${input.patientId}`]);

      const c = await this.classificar(input.read.labels, cli);
      accepted = c.accepted;
      rejected = c.rejected;

      await cli.query('DELETE FROM patient_device_types WHERE patient_id = $1', [input.patientId]);
      for (const code of accepted) {
        await cli.query(
          `INSERT INTO patient_device_types (patient_id, device_type, source)
           VALUES ($1, $2, $3)`,
          [input.patientId, code, source]);
      }

      // Quarentena do que o ConceptMap não conhece — mesmo destino da migration 308.
      // `ordinal` cresce a partir de 1; `Tipo de Dispositivo` é o campo SEM teto (migration 309),
      // então não há como isto ser recusado por cardinalidade.
      for (let i = 0; i < c.unmappedLabels.length; i++) {
        await cli.query(
          `INSERT INTO patient_source_labels (patient_id, field_name, ordinal, raw_label, source)
           VALUES ($1, 'Tipo de Dispositivo', $2, $3, $4)
           ON CONFLICT DO NOTHING`,
          [input.patientId, i + 1, c.unmappedLabels[i], `${source}-quarentena`]);
        quarantined++;
      }

      if (proprio) await cli.query('COMMIT');
    } catch (err) {
      if (proprio) await cli.query('ROLLBACK');
      throw err;
    } finally {
      if (proprio) cli.release();
    }

    if (rejected.length > 0) {
      // C1: contagem por motivo. O rótulo recusado NÃO sai no log.
      const porMotivo = rejected.reduce<Record<string, number>>((a, r) => {
        a[r.reason] = (a[r.reason] ?? 0) + 1; return a;
      }, {});
      console.warn('[PatientDeviceTypeRepository] tipo(s) de dispositivo recusado(s):', {
        field: 'Tipo de Dispositivo', received: input.read.labels.length,
        accepted: accepted.length, byReason: porMotivo, quarantined,
      });
    }

    return { outcome: 'written', received: input.read.labels.length, accepted, rejected, quarantined };
  }

  /** Leitura interna. */
  async findByPatientId(patientId: string): Promise<string[]> {
    const r = await this.pool.query<{ device_type: string }>(
      `SELECT pdt.device_type
         FROM patient_device_types pdt
         JOIN device_types d ON d.code = pdt.device_type
        WHERE pdt.patient_id = $1
        ORDER BY d.sort_order, d.code`, [patientId]);
    return r.rows.map(x => x.device_type);
  }

  /**
   * Suprime os tipos de um paciente. Mesma razão da C-B do parecer do `lex` na Fase 2: o
   * `ON DELETE CASCADE` nunca dispara, porque não há hard delete de paciente e não haverá
   * (ata `2026-07-22a#REQ-04`).
   */
  async purgeForPatient(patientId: string, client?: PoolClient): Promise<number> {
    const exec = client ?? this.pool;
    const r = await exec.query('DELETE FROM patient_device_types WHERE patient_id = $1', [patientId]);
    const n = r.rowCount ?? 0;
    console.info('[PatientDeviceTypeRepository] dispositivos suprimidos com o paciente (C-B/lex):', { patientId, linhas: n });
    return n;
  }
}
