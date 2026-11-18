import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';

/**
 * Tabela `therapeutic_segments`: Congelada na 091 (toda inativa; não editar nem reativar).
 * Este leitor é o ÚNICO consumidor dela: alimenta o marcador `CATALOGO_SEGMENTOS_CLINICOS` do prompt do resumo de admissão (DD-17).
 * Lê TODOS os rótulos, SEM filtro de `active`, porque a 586 desativou os 13 segmentos e o resumo continua idêntico ao de antes.
 * Fica no módulo `matching` porque o kind `segments` saiu do domínio do catálogo (DF-1). PTI, admin e PDF não leem segmento.
 * Padrão: Adapter de leitura (uma consulta, uma responsabilidade); o SQL fica só aqui.
 */
export class SegmentLabelsReader {
  private poolMemo: Pick<Pool, 'query'> | null;

  constructor(pool: Pick<Pool, 'query'> | null = null) {
    this.poolMemo = pool;
  }

  private get pool(): Pick<Pool, 'query'> {
    this.poolMemo ??= DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  async list(): Promise<string[]> {
    const { rows } = await this.pool.query<{ label: string }>(
      'SELECT label FROM therapeutic_segments ORDER BY sort_order, lower(label)',
    );
    return rows.map((r) => r.label);
  }
}
