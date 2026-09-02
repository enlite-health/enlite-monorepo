import {
  reactivateIfArchivedByUs,
  reactivateOnActivity,
  REACTIVATION_JOB,
} from '../ReactivateArchivedWorkerUseCase';
import { reportError } from '@shared/logging';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: jest.fn() },
}));

jest.mock('@shared/logging', () => ({
  reportError: jest.fn(),
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
  loggingAls: undefined,
}));

const WID = '84eb35fe-73d1-4b79-b186-c41b0b64fd31';

/**
 * `originRow` = o que a leitura de origem devolve.
 * `updateRowCount` = linhas afetadas pelo UPDATE de `workers` (0 = alguém correu na frente).
 */
function makeDeps(
  originRow: { status: string; archived_by: string | null; ever_requested: boolean } | null,
  updateRowCount = 1,
) {
  const client = {
    query: jest.fn().mockImplementation((sql: string) => {
      if (String(sql).includes('UPDATE workers')) {
        return Promise.resolve({ rows: [], rowCount: updateRowCount });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }),
    release: jest.fn(),
  };
  const pool = {
    query: jest.fn().mockResolvedValue({
      rows: originRow ? [originRow] : [],
      rowCount: originRow ? 1 : 0,
    }),
    connect: jest.fn().mockResolvedValue(client),
  };
  return { pool, client };
}

const archivedByUs = (job: string) => ({
  status: 'DISABLED',
  archived_by: job,
  ever_requested: false,
});

const sqlsOf = (client: { query: jest.Mock }) => client.query.mock.calls.map((c) => String(c[0]));

beforeEach(() => jest.clearAllMocks());

describe('reactivateIfArchivedByUs', () => {
  describe('reativa apenas os jobs da allow-list', () => {
    it.each(['system:bulk-archive-stale-2026-01-30', 'system:redisable-30d-cut-2026-08-11'])(
      '%s → reativa',
      async (job) => {
        const { pool, client } = makeDeps(archivedByUs(job));

        await expect(reactivateIfArchivedByUs(pool as never, WID)).resolves.toBe(true);

        const sqls = sqlsOf(client);
        expect(sqls.some((s) => s.includes('BEGIN'))).toBe(true);
        expect(sqls.some((s) => s.includes('COMMIT'))).toBe(true);
        expect(sqls.some((s) => s.includes('UPDATE workers'))).toBe(true);
      },
    );

    // A trava que o parecer `lex` exigiu: prefixo `system:%` seria convenção, não garantia.
    // `changed_by` é VARCHAR livre — um caminho de baixa futuro que grave `system:` por descuido
    // NÃO pode passar a reverter a vontade do titular em silêncio.
    it.each([
      'system:algum-job-futuro-nao-classificado',
      'system:baja-a-pedido-implementada-amanha',
      'system:',
    ])('%s (system: mas fora da allow-list) → NÃO reativa', async (job) => {
      const { pool, client } = makeDeps(archivedByUs(job));

      await expect(reactivateIfArchivedByUs(pool as never, WID)).resolves.toBe(false);
      expect(pool.connect).not.toHaveBeenCalled();
      expect(client.query).not.toHaveBeenCalled();
    });

    it('carimba a autoria com o job próprio, para a coorte ficar isolável depois', async () => {
      const { pool, client } = makeDeps(archivedByUs('system:bulk-archive-stale-2026-01-30'));

      await reactivateIfArchivedByUs(pool as never, WID);

      const actorCall = client.query.mock.calls.find((c) =>
        String(c[0]).includes('app.current_uid'),
      );
      expect(actorCall).toBeDefined();
      expect(actorCall![1]).toEqual([`system:${REACTIVATION_JOB}`]);
    });

    it('restaura para INCOMPLETE_REGISTER, e só enquanto ainda está DISABLED', async () => {
      const { pool, client } = makeDeps(archivedByUs('system:bulk-archive-stale-2026-01-30'));

      await reactivateIfArchivedByUs(pool as never, WID);

      const call = client.query.mock.calls.find((c) => String(c[0]).includes('UPDATE workers'));
      expect(String(call![0])).toContain("AND status = 'DISABLED'");
      expect(call![1]).toEqual([WID, 'INCOMPLETE_REGISTER']);
    });
  });

  // Parecer `lex` (PARE): `reason='admin'` não prova origem administrativa — o lote sobrescreveu
  // `reason` via ON CONFLICT numa tabela sem histórico. Religar automaticamente arriscaria mandar
  // mensagem a quem pediu para não receber.
  it('NUNCA escreve em messaging_opt_out', async () => {
    const { pool, client } = makeDeps(archivedByUs('system:bulk-archive-stale-2026-01-30'));

    await reactivateIfArchivedByUs(pool as never, WID);

    expect(sqlsOf(client).some((s) => s.includes('messaging_opt_out'))).toBe(false);
  });

  describe('NÃO reativa quem pediu para sair', () => {
    it.each([
      ['luz:baja-cuenta', 'baixa pedida na conversa com a Luz'],
      ['lgpd:baja-solicitada:camila-vald', 'baixa por direito do titular'],
      ['worker_self', 'a própria pessoa desativou'],
      ['staff:flor@enlite.health', 'staff desativou a pedido dela'],
    ])('arquivamento mais recente = %s (%s) → não toca em nada', async (job) => {
      const { pool, client } = makeDeps({
        status: 'DISABLED',
        archived_by: job,
        ever_requested: true,
      });

      await expect(reactivateIfArchivedByUs(pool as never, WID)).resolves.toBe(false);
      expect(pool.connect).not.toHaveBeenCalled();
      expect(client.query).not.toHaveBeenCalled();
    });

    // O segundo furo que o `lex` apontou: olhar só a última transição deixa passar quem pediu
    // baixa, foi reativado por staff e depois caiu no lote.
    it('pediu baixa no PASSADO e o lote arquivou por cima → NÃO reativa', async () => {
      const { pool, client } = makeDeps({
        status: 'DISABLED',
        archived_by: 'system:bulk-archive-stale-2026-01-30',
        ever_requested: true,
      });

      await expect(reactivateIfArchivedByUs(pool as never, WID)).resolves.toBe(false);
      expect(client.query).not.toHaveBeenCalled();
    });

    it('a consulta varre o histórico inteiro, não só a última transição', async () => {
      const { pool } = makeDeps(archivedByUs('system:bulk-archive-stale-2026-01-30'));

      await reactivateIfArchivedByUs(pool as never, WID);

      const sql = String(pool.query.mock.calls[0][0]);
      expect(sql).toContain('EXISTS');
      expect(pool.query.mock.calls[0][1][1]).toEqual([
        'luz:%',
        'lgpd:%',
        'worker_self%',
        'staff:%',
      ]);
    });
  });

  describe('falha fechada — na dúvida, não reativa', () => {
    it('worker inexistente → false, sem escrita', async () => {
      const { pool } = makeDeps(null);
      await expect(reactivateIfArchivedByUs(pool as never, WID)).resolves.toBe(false);
      expect(pool.connect).not.toHaveBeenCalled();
    });

    it('sem histórico de arquivamento (archived_by null) → false', async () => {
      const { pool } = makeDeps({ status: 'DISABLED', archived_by: null, ever_requested: false });
      await expect(reactivateIfArchivedByUs(pool as never, WID)).resolves.toBe(false);
      expect(pool.connect).not.toHaveBeenCalled();
    });

    it('a consulta de origem explode → false, NÃO propaga, e LOGA (não some em silêncio)', async () => {
      const pool = {
        query: jest.fn().mockRejectedValue(new Error('connection terminated')),
        connect: jest.fn(),
      };

      await expect(reactivateIfArchivedByUs(pool as never, WID)).resolves.toBe(false);
      expect(reportError).toHaveBeenCalledTimes(1);

      // Contexto só com o id: `err.detail` do Postgres ecoa a linha do worker, que é PII.
      const [, context] = (reportError as jest.Mock).mock.calls[0];
      expect(context).toEqual({
        source: 'ReactivateArchivedWorkerUseCase:reactivateIfArchivedByUs',
        workerId: WID,
      });
    });

    it('rejeição que não é Error (driver pode lançar qualquer coisa) → não quebra o reporte', async () => {
      const pool = {
        query: jest.fn().mockRejectedValue('ECONNRESET'),
        connect: jest.fn(),
      };

      await expect(reactivateIfArchivedByUs(pool as never, WID)).resolves.toBe(false);
      expect(reportError).toHaveBeenCalledTimes(1);

      const [err] = (reportError as jest.Mock).mock.calls[0];
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe('ECONNRESET');
    });

    it('a transação explode → false, NÃO propaga, e LOGA', async () => {
      const { pool } = makeDeps(archivedByUs('system:bulk-archive-stale-2026-01-30'));
      pool.connect = jest.fn().mockRejectedValue(new Error('pool exhausted'));

      await expect(reactivateIfArchivedByUs(pool as never, WID)).resolves.toBe(false);
      expect(reportError).toHaveBeenCalledTimes(1);
    });
  });

  describe('idempotência e corrida', () => {
    it('worker não está DISABLED → false, sem abrir transação', async () => {
      const { pool } = makeDeps({
        status: 'INCOMPLETE_REGISTER',
        archived_by: 'system:bulk-archive-stale-2026-01-30',
        ever_requested: false,
      });
      await expect(reactivateIfArchivedByUs(pool as never, WID)).resolves.toBe(false);
      expect(pool.connect).not.toHaveBeenCalled();
    });

    it('outra transação reativou primeiro (UPDATE afeta 0) → false', async () => {
      const { pool } = makeDeps(archivedByUs('system:bulk-archive-stale-2026-01-30'), 0);
      await expect(reactivateIfArchivedByUs(pool as never, WID)).resolves.toBe(false);
    });
  });
});

describe('reactivateOnActivity — o guard do caminho quente', () => {
  function mockPool(originRow: Record<string, unknown> | null) {
    const client = {
      query: jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
      release: jest.fn(),
    };
    const pool = {
      query: jest.fn().mockResolvedValue({ rows: originRow ? [originRow] : [] }),
      connect: jest.fn().mockResolvedValue(client),
    };
    (DatabaseConnection.getInstance as jest.Mock).mockReturnValue({ getPool: () => pool });
    return pool;
  }

  it('status diferente de DISABLED → null SEM tocar no banco (curto-circuito)', async () => {
    const pool = mockPool(null);
    await expect(reactivateOnActivity(WID, 'INCOMPLETE_REGISTER')).resolves.toBeNull();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('DISABLED por lote da allow-list → devolve o status restaurado', async () => {
    mockPool(archivedByUs('system:bulk-archive-stale-2026-01-30'));
    await expect(reactivateOnActivity(WID, 'DISABLED')).resolves.toBe('INCOMPLETE_REGISTER');
  });

  it('DISABLED por baixa a pedido → null', async () => {
    mockPool({ status: 'DISABLED', archived_by: 'luz:baja-cuenta', ever_requested: true });
    await expect(reactivateOnActivity(WID, 'DISABLED')).resolves.toBeNull();
  });
});
