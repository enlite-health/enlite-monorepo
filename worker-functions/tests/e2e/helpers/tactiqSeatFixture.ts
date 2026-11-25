import type { Pool, PoolClient } from 'pg';

/**
 * tactiqSeatFixture — semeia a declaração "Licencia asignada" do Acesso Master (change tactiq-vinculo-resiliente, F5, design D16).
 *
 * Desde a F5 o `startLink` (e o `POST /me/tactiq-link`) recusa 409 quem não tem linha em `tactiq_links` NEM licença declarada. Os e2e que
 * vinculam uma pessoa sem linha prévia chamam isto antes, no lugar de passar pela rota do Master. O kind vai por parâmetro (o scanner
 * de SQL lê literal `tabela.coluna`). Só no banco de teste; a trilha é append-only (cada e-mail leva o sufixo da rodada).
 */
type Db = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

/** `at` padrão = 1 min atrás: a declaração vem ANTES de tudo o que o teste grava com o relógio dele (a ordem da trilha é por `at`). */
export async function declareTactiqSeat(db: Db, email: string, opts: { at?: Date; actorUid?: string } = {}): Promise<void> {
  await db.query(
    `INSERT INTO admission_events (host_email, kind, outcome, at, ref) VALUES (lower($1), $2, $3, $4, $5::jsonb)`,
    [email, 'tactiq_link.seat_declared', 'declared', opts.at ?? new Date(Date.now() - 60_000), JSON.stringify({ actorUid: opts.actorUid ?? 'e2e-seed' })],
  );
}
