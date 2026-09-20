/**
 * src/modules/anacare-hours/infrastructure/AnaCareDirectorySnapshotRepository.ts
 *
 * Acesso a `anacare_directory_snapshot` (migration 439) — a última contagem TOTAL conhecida do
 * diretório Enlite, usada pelo `AnaCareHoursSyncRunner` como linha-base do alarme de queda (a
 * raspagem quebra em silêncio, nunca erro de rede).
 *
 * Extraído (passo 2, conserto 17/09) do antigo `AnaCareShiftRepository` — esses dois métodos
 * viviam numa classe chamada "repositório de turno" mas guardavam estado que não é de turno
 * nenhum (achado da revisão do passo 2). `AnaCareShiftRepository` foi apagado por completo: o
 * antigo retrato POR TURNO não tem mais escritor nem leitor de produção desde o passo 1 — a
 * tabela em si continua existindo (fase de DROP é outra), só o código morto foi removido.
 */
import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import type { DirectorySnapshotRepository } from '../domain/AnaCareHoursSyncPorts';

export class AnaCareDirectorySnapshotRepository implements DirectorySnapshotRepository {
  private poolMemo?: Pool;

  private get pool(): Pool {
    this.poolMemo ??= DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  /** Última contagem TOTAL conhecida do diretório Enlite. `null` = primeira execução. */
  async getLastDirectoryCount(): Promise<number | null> {
    const res = await this.pool.query<{ last_total_count: number }>(
      `SELECT last_total_count FROM anacare_directory_snapshot WHERE id = 1`,
    );
    return res.rows[0] ? Number(res.rows[0].last_total_count) : null;
  }

  async setLastDirectoryCount(count: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO anacare_directory_snapshot (id, last_total_count, updated_at)
       VALUES (1, $1, NOW())
       ON CONFLICT (id) DO UPDATE SET last_total_count = EXCLUDED.last_total_count, updated_at = NOW()`,
      [count],
    );
  }
}
