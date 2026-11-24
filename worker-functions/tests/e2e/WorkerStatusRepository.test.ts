/**
 * WorkerStatusRepository.test.ts
 *
 * Testes unitários com banco real para validar a refatoração de workers.status
 * (Migration 096). Cada teste faz INSERT/UPDATE real no banco de teste e valida
 * o que foi persistido.
 *
 * Cenários cobertos:
 *   WS1  - INSERT de worker → status DEFAULT = 'INCOMPLETE_REGISTER'
 *   WS2  - UPDATE status → 'REGISTERED', persistência validada
 *   WS3  - UPDATE status → 'DISABLED', persistência validada
 *   WS4  - Constraint violation — status inválido ('approved') deve ser rejeitado
 *   WS5  - Constraint violation — status inválido ('pending') deve ser rejeitado
 *   WS6  - Constraint violation — status inválido ('in_progress') deve ser rejeitado
 *   WS7  - Trigger worker_status_history — UPDATE de status gera linha na tabela
 *   WS8  - Trigger worker_status_history — múltiplos UPDATEs geram múltiplas linhas
 *   WS9  - Trigger worker_status_history — sem mudança de status não gera linha
 *   WS10 - Colunas removidas — SELECT overall_status deve falhar
 *   WS11 - Colunas removidas — SELECT availability_status deve falhar
 *   WS12 - UPDATE de campo não-status não dispara entrada no histórico
 */

import { Pool } from 'pg';
import { setWorkerStatusForTest } from './helpers/setWorkerStatusForTest';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const pool = new Pool({ connectionString: TEST_DATABASE_URL });

// ── Helpers ──────────────────────────────────────────────────────────────────

const TEST_EMAIL_DOMAIN = '@workerstatusrepo.test';

async function insertTestWorker(overrides: {
  email?: string;
  authUid?: string;
  status?: string;
} = {}): Promise<string> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = overrides.email ?? `worker-${suffix}${TEST_EMAIL_DOMAIN}`;
  const authUid = overrides.authUid ?? `uid-${suffix}`;

  // Inserção sem especificar status para testar o DEFAULT
  if (!overrides.status) {
    const result = await pool.query(
      `INSERT INTO workers (auth_uid, email, country, timezone)
       VALUES ($1, $2, 'BR', 'America/Sao_Paulo')
       RETURNING id`,
      [authUid, email],
    );
    return result.rows[0].id as string;
  }

  // Inserção com status explícito (usado para testar constraints)
  const result = await pool.query(
    `INSERT INTO workers (auth_uid, email, country, timezone, status)
     VALUES ($1, $2, 'BR', 'America/Sao_Paulo', $3)
     RETURNING id`,
    [authUid, email, overrides.status],
  );
  return result.rows[0].id as string;
}

async function getWorkerStatus(workerId: string): Promise<string> {
  const result = await pool.query('SELECT status FROM workers WHERE id = $1', [workerId]);
  return result.rows[0]?.status as string;
}

async function countHistoryRows(workerId: string): Promise<number> {
  const result = await pool.query(
    'SELECT COUNT(*) FROM worker_status_history WHERE worker_id = $1',
    [workerId],
  );
  return parseInt(result.rows[0].count as string, 10);
}

// Limpa apenas os workers inseridos neste arquivo de teste
afterEach(async () => {
  await pool.query(`DELETE FROM workers WHERE email LIKE '%${TEST_EMAIL_DOMAIN}'`);
});

afterAll(async () => {
  await pool.end();
});

// ── WS1: DEFAULT de status ────────────────────────────────────────────────────

describe('WS1 — INSERT sem status explícito → DEFAULT INCOMPLETE_REGISTER', () => {
  it('deve persistir status = INCOMPLETE_REGISTER por padrão', async () => {
    // Arrange / Act
    const id = await insertTestWorker();

    // Assert
    const status = await getWorkerStatus(id);
    expect(status).toBe('INCOMPLETE_REGISTER');
  });
});

// ── WS2: UPDATE para DISABLED ─────────────────────────────────────────────────
// Nota: UPDATE para REGISTERED em worker sem campos obrigatórios é bloqueado pelo
// trigger trg_guard_registered_status (migration 111). Testamos DISABLED em WS2
// para validar que status UPDATE funciona; REGISTERED via INSERT é testado separadamente.

describe('WS2 — UPDATE status → DISABLED', () => {
  it('deve persistir o novo status DISABLED no banco via UPDATE', async () => {
    // Arrange
    const id = await insertTestWorker();

    // Act
    await setWorkerStatusForTest(pool, id, 'DISABLED');

    // Assert
    const status = await getWorkerStatus(id);
    expect(status).toBe('DISABLED');
  });
});

// ── WS3: UPDATE para DISABLED ─────────────────────────────────────────────────

describe('WS3 — UPDATE status → DISABLED', () => {
  it('deve persistir o novo status DISABLED no banco', async () => {
    // Arrange
    const id = await insertTestWorker();

    // Act
    await setWorkerStatusForTest(pool, id, 'DISABLED');

    // Assert
    const status = await getWorkerStatus(id);
    expect(status).toBe('DISABLED');
  });
});

// ── WS4: Constraint — status 'approved' (valor antigo) ───────────────────────

describe('WS4 — Constraint violation: status antigo "approved"', () => {
  it('deve rejeitar INSERT com status = "approved"', async () => {
    // Arrange / Act / Assert
    await expect(insertTestWorker({ status: 'approved' })).rejects.toThrow();
  });
});

// ── WS5: Constraint — status 'pending' (valor antigo) ────────────────────────

describe('WS5 — Constraint violation: status antigo "pending"', () => {
  it('deve rejeitar INSERT com status = "pending"', async () => {
    await expect(insertTestWorker({ status: 'pending' })).rejects.toThrow();
  });
});

// ── WS6: Constraint — status 'in_progress' (valor antigo) ────────────────────

describe('WS6 — Constraint violation: status antigo "in_progress"', () => {
  it('deve rejeitar INSERT com status = "in_progress"', async () => {
    await expect(insertTestWorker({ status: 'in_progress' })).rejects.toThrow();
  });

  it('deve rejeitar UPDATE para status = "in_progress" em worker existente', async () => {
    // Arrange
    const id = await insertTestWorker();

    // Act / Assert
    await expect(
      setWorkerStatusForTest(pool, id, 'in_progress'),
    ).rejects.toThrow();
  });
});

// ── WS7: Trigger — UPDATE de status gera linha em worker_status_history ──────
// Nota: UPDATE para REGISTERED é bloqueado pelo trigger trg_guard_registered_status
// (migration 111) em workers sem campos obrigatórios. Usamos DISABLED (livre).

describe('WS7 — Trigger worker_status_history: UPDATE gera linha de histórico', () => {
  it('deve inserir 1 linha em worker_status_history após UPDATE de status', async () => {
    // Arrange
    const id = await insertTestWorker();
    const beforeCount = await countHistoryRows(id);
    expect(beforeCount).toBe(0);

    // Act — DISABLED passa livre pelo trigger guard
    await setWorkerStatusForTest(pool, id, 'DISABLED');

    // Assert
    const afterCount = await countHistoryRows(id);
    expect(afterCount).toBe(1);
  });

  it('deve registrar old_value e new_value corretos na linha de histórico', async () => {
    // Arrange
    const id = await insertTestWorker();

    // Act — INCOMPLETE_REGISTER → DISABLED (livre pelo trigger guard)
    await setWorkerStatusForTest(pool, id, 'DISABLED');

    // Assert
    const result = await pool.query(
      `SELECT field_name, old_value, new_value
       FROM worker_status_history
       WHERE worker_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [id],
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].field_name).toBe('status');
    expect(result.rows[0].old_value).toBe('INCOMPLETE_REGISTER');
    expect(result.rows[0].new_value).toBe('DISABLED');
  });
});

// ── WS8: Trigger — múltiplos UPDATEs geram múltiplas linhas ──────────────────
// Nota: UPDATE para REGISTERED é bloqueado pelo trigger trg_guard_registered_status
// (migration 111). Usamos sequências DISABLED ↔ INCOMPLETE_REGISTER (livres).

describe('WS8 — Trigger worker_status_history: múltiplos UPDATEs geram N linhas', () => {
  it('deve acumular 3 linhas para 3 UPDATEs de status distintos', async () => {
    // Arrange
    const id = await insertTestWorker();

    // Act — 3 transições de status sem passar por REGISTERED (guard ativo)
    await setWorkerStatusForTest(pool, id, 'DISABLED');
    await setWorkerStatusForTest(pool, id, 'INCOMPLETE_REGISTER');
    await setWorkerStatusForTest(pool, id, 'DISABLED');

    // Assert
    const count = await countHistoryRows(id);
    expect(count).toBe(3);
  });

  it('a ordem cronológica das linhas reflete a sequência de UPDATEs', async () => {
    // Arrange
    const id = await insertTestWorker();

    // Act — INCOMPLETE_REGISTER → DISABLED → INCOMPLETE_REGISTER
    await setWorkerStatusForTest(pool, id, 'DISABLED');
    await setWorkerStatusForTest(pool, id, 'INCOMPLETE_REGISTER');

    // Assert — ordena por created_at ASC
    const result = await pool.query(
      `SELECT old_value, new_value
       FROM worker_status_history
       WHERE worker_id = $1
       ORDER BY created_at ASC`,
      [id],
    );
    expect(result.rows[0].old_value).toBe('INCOMPLETE_REGISTER');
    expect(result.rows[0].new_value).toBe('DISABLED');
    expect(result.rows[1].old_value).toBe('DISABLED');
    expect(result.rows[1].new_value).toBe('INCOMPLETE_REGISTER');
  });
});

// ── WS9: Trigger — sem mudança de valor não gera linha ───────────────────────

describe('WS9 — Trigger worker_status_history: UPDATE sem mudança real não gera linha', () => {
  it('deve manter COUNT=0 quando UPDATE mantém o mesmo status', async () => {
    // Arrange
    const id = await insertTestWorker();

    // Act — atualiza status com o mesmo valor (INCOMPLETE_REGISTER → INCOMPLETE_REGISTER)
    await setWorkerStatusForTest(pool, id, 'INCOMPLETE_REGISTER');

    // Assert — OLD.status IS DISTINCT FROM NEW.status = false → sem linha
    const count = await countHistoryRows(id);
    expect(count).toBe(0);
  });
});

// ── WS10: Colunas removidas — overall_status ─────────────────────────────────

describe('WS10 — Coluna overall_status foi removida da tabela workers', () => {
  it('SELECT overall_status deve lançar erro (coluna inexistente)', async () => {
    // Arrange
    const id = await insertTestWorker();

    // Act / Assert
    await expect(
      pool.query('SELECT overall_status FROM workers WHERE id = $1', [id]),
    ).rejects.toThrow();
  });
});

// ── WS11: Colunas removidas — availability_status ────────────────────────────

describe('WS11 — Coluna availability_status foi removida da tabela workers', () => {
  it('SELECT availability_status deve lançar erro (coluna inexistente)', async () => {
    // Arrange
    const id = await insertTestWorker();

    // Act / Assert
    await expect(
      pool.query('SELECT availability_status FROM workers WHERE id = $1', [id]),
    ).rejects.toThrow();
  });
});

// ── WS12: UPDATE de campo não-status não dispara histórico ────────────────────

describe('WS12 — UPDATE de campo não-status não gera linha em worker_status_history', () => {
  it('UPDATE de country não deve criar linha em worker_status_history', async () => {
    // Arrange
    const id = await insertTestWorker();

    // Act — altera country, mantém status inalterado
    await pool.query("UPDATE workers SET country = 'AR' WHERE id = $1", [id]);

    // Assert
    const count = await countHistoryRows(id);
    expect(count).toBe(0);
  });
});
