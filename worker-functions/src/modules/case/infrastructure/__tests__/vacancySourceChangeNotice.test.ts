/**
 * vacancySourceChangeNotice — a decisão de gravar o aviso (F3, vaga-le-do-servico-contratado).
 * Client mockado: aqui se prova a DECISÃO (valor normalizado mudou? o `field` certo?) e o que vai ao log;
 * o SQL contra Postgres real (rascunho, encerrada, upsert, índice parcial, ack) é o e2e
 * `tests/e2e/vacancySourceChangeNotice.e2e.test.ts`.
 */
const mockInfo = jest.fn();
jest.mock('@shared/logging', () => ({ logger: { info: mockInfo, warn: jest.fn(), error: jest.fn() } }));

import type { PoolClient } from 'pg';
import {
  SOURCE_CHANGE_FIELDS,
  acknowledgeNotice,
  GUARDED_SERVICE_COLUMNS,
  captureFieldBefore,
  isClearedValue,
  isSourceChangeField,
  recordFieldChange,
  recordSourceChange,
} from '../vacancySourceChangeNotice';

const A = { dayOfWeek: 1, startTime: '08:00', endTime: '12:00' };
const B = { dayOfWeek: 3, startTime: '14:00', endTime: '18:00' };

function cli(rows: unknown[] = []) {
  return { query: jest.fn().mockResolvedValue({ rows, rowCount: rows.length }) } as unknown as PoolClient & { query: jest.Mock };
}

beforeEach(() => jest.clearAllMocks());

describe('vacancySourceChangeNotice — conjunto fechado de campos', () => {
  it('são exatamente schedule | providers_needed | age_range', () => {
    expect([...SOURCE_CHANGE_FIELDS]).toEqual(['schedule', 'providers_needed', 'age_range']);
    expect(['schedule', 'providers_needed', 'age_range'].every(isSourceChangeField)).toBe(true);
    expect(isSourceChangeField('address')).toBe(false);
    expect(isSourceChangeField('')).toBe(false);
  });
});

describe('captureFieldBefore — schedule', () => {
  it('PATCH que não toca o horário (undefined) → não consulta nada', async () => {
    const c = cli();
    expect(await captureFieldBefore(c, 'svc-1', 'schedule', undefined)).toBeUndefined();
    expect(c.query).not.toHaveBeenCalled();
  });

  it('lê o horário atual travando a linha (FOR UPDATE)', async () => {
    const c = cli([{ schedule: [A] }]);
    expect(await captureFieldBefore(c, 'svc-1', 'schedule', [B])).toEqual([A]);
    expect(c.query.mock.calls[0][0]).toMatch(/^SELECT schedule FROM patient_contracted_services WHERE id = \$1 FOR UPDATE$/);
    expect(c.query.mock.calls[0][1]).toEqual(['svc-1']);
  });

  it('serviço sem horário (NULL) ou inexistente (0 linhas) → null', async () => {
    expect(await captureFieldBefore(cli([{ schedule: null }]), 'svc-1', 'schedule', [A])).toBeNull();
    expect(await captureFieldBefore(cli([]), 'svc-1', 'schedule', [A])).toBeNull();
  });
});

describe('recordFieldChange (schedule) — só grava quando o valor NORMALIZADO mudou', () => {
  it('horário mudou → grava o aviso de `schedule` para o serviço', async () => {
    const c = cli([{ job_posting_id: 'vac-1' }]);
    await recordFieldChange(c, 'svc-1', 'schedule', [A], [B]);
    expect(c.query).toHaveBeenCalledTimes(1);
    expect(c.query.mock.calls[0][1]).toEqual(['svc-1', 'schedule']);
  });

  it('valor igual → 0 gravações', async () => {
    const c = cli();
    await recordFieldChange(c, 'svc-1', 'schedule', [A], [{ ...A }]);
    expect(c.query).not.toHaveBeenCalled();
  });

  it('mesmo conteúdo com os slots em OUTRA ordem (e chaves em outra ordem) → 0 gravações', async () => {
    const c = cli();
    await recordFieldChange(c, 'svc-1', 'schedule', [A, B], [
      { endTime: '18:00', startTime: '14:00', dayOfWeek: 3 },
      { endTime: '12:00', startTime: '08:00', dayOfWeek: 1 },
    ]);
    expect(c.query).not.toHaveBeenCalled();
  });

  it('PATCH sem horário (undefined) → 0 gravações', async () => {
    const c = cli();
    await recordFieldChange(c, 'svc-1', 'schedule', undefined, undefined);
    expect(c.query).not.toHaveBeenCalled();
  });

  it('NULL → [] não é mudança (ambos "sem horário"); NULL → horário é', async () => {
    const c = cli();
    await recordFieldChange(c, 'svc-1', 'schedule', null, []);
    expect(c.query).not.toHaveBeenCalled();
    await recordFieldChange(c, 'svc-1', 'schedule', null, [A]);
    expect(c.query).toHaveBeenCalledTimes(1);
  });

  it('um slot a mais ou um horário diferente no mesmo dia → grava', async () => {
    const c = cli();
    await recordFieldChange(c, 'svc-1', 'schedule', [A], [A, B]);
    await recordFieldChange(c, 'svc-1', 'schedule', [A], [{ ...A, endTime: '12:30' }]);
    expect(c.query).toHaveBeenCalledTimes(2);
  });
});

describe('providers_needed (F5) — captura, decisão de gravar e o que conta como "apagar"', () => {
  it('captura lê SÓ a coluna providers_needed do serviço, travando a linha; PATCH sem o campo não consulta', async () => {
    const c = cli([{ providers_needed: 2 }]);
    expect(await captureFieldBefore(c, 'svc-1', 'providers_needed', 3)).toBe(2);
    expect(c.query.mock.calls[0][0]).toMatch(/^SELECT providers_needed FROM patient_contracted_services WHERE id = \$1 FOR UPDATE$/);
    const d = cli();
    expect(await captureFieldBefore(d, 'svc-1', 'providers_needed', undefined)).toBeUndefined();
    expect(d.query).not.toHaveBeenCalled();
  });

  it('serviço sem quantidade (NULL) ou inexistente → null', async () => {
    expect(await captureFieldBefore(cli([{ providers_needed: null }]), 'svc-1', 'providers_needed', 3)).toBeNull();
    expect(await captureFieldBefore(cli([]), 'svc-1', 'providers_needed', 3)).toBeNull();
  });

  it('valor mudou (2 → 3, null → 2, 2 → null) → grava o aviso `providers_needed`; valor igual ou PATCH sem o campo → 0 gravações', async () => {
    const c = cli([{ job_posting_id: 'vac-1' }]);
    await recordFieldChange(c, 'svc-1', 'providers_needed', 2, 3);
    await recordFieldChange(c, 'svc-1', 'providers_needed', null, 2);
    await recordFieldChange(c, 'svc-1', 'providers_needed', 2, null);
    expect(c.query).toHaveBeenCalledTimes(3);
    expect(c.query.mock.calls.map((x) => x[1])).toEqual([['svc-1', 'providers_needed'], ['svc-1', 'providers_needed'], ['svc-1', 'providers_needed']]);
    const z = cli();
    await recordFieldChange(z, 'svc-1', 'providers_needed', 2, 2);
    await recordFieldChange(z, 'svc-1', 'providers_needed', null, null);
    await recordFieldChange(z, 'svc-1', 'providers_needed', undefined, undefined);
    expect(z.query).not.toHaveBeenCalled();
  });

  it('isClearedValue: schedule null/[] e providers_needed null/0 apagam; ausente, horário e quantidade válidos não', () => {
    expect(isClearedValue('schedule', null)).toBe(true);
    expect(isClearedValue('schedule', [])).toBe(true);
    expect(isClearedValue('schedule', [A])).toBe(false);
    expect(isClearedValue('schedule', undefined)).toBe(false);
    expect(isClearedValue('providers_needed', null)).toBe(true);
    expect(isClearedValue('providers_needed', 0)).toBe(true);
    expect(isClearedValue('providers_needed', 2)).toBe(false);
    expect(isClearedValue('providers_needed', undefined)).toBe(false);
  });

  it('os campos vigiados são colunas reais do serviço, em conjunto fechado', () => {
    expect({ ...GUARDED_SERVICE_COLUMNS }).toEqual({ schedule: 'schedule', providers_needed: 'providers_needed' });
  });
});

describe('recordSourceChange — o ponto reutilizável (F5/F6 chamam com outro field)', () => {
  it('INSERT … SELECT só de vaga publicada e viva, upsert no aviso aberto; devolve os ids', async () => {
    const c = cli([{ job_posting_id: 'vac-1' }, { job_posting_id: 'vac-2' }]);
    const ids = await recordSourceChange(c, 'svc-1', 'providers_needed');
    expect(ids).toEqual(['vac-1', 'vac-2']);
    const [sql, params] = c.query.mock.calls[0];
    const norm = String(sql).replace(/\s+/g, ' ');
    expect(norm).toContain('jp.is_draft = false');
    expect(norm).toContain("jp.deleted_at IS NULL AND COALESCE(jp.status, '') NOT IN ('DE_BAJA', 'CLOSED')");
    expect(norm).toContain('ON CONFLICT (job_posting_id, field) WHERE acknowledged_at IS NULL DO UPDATE SET changed_at = now()');
    expect(params).toEqual(['svc-1', 'providers_needed']);
  });

  it('log só com { jobPostingId, field } — nunca valor', async () => {
    await recordSourceChange(cli([{ job_posting_id: 'vac-1' }]), 'svc-1', 'schedule');
    expect(mockInfo).toHaveBeenCalledTimes(1);
    expect(mockInfo.mock.calls[0][0]).toEqual({ jobPostingId: 'vac-1', field: 'schedule' });
    expect(JSON.stringify(mockInfo.mock.calls)).not.toMatch(/08:00|startTime|dayOfWeek/);
  });

  it('sem vaga publicada viva → [] e nenhum log', async () => {
    expect(await recordSourceChange(cli([]), 'svc-1', 'schedule')).toEqual([]);
    expect(mockInfo).not.toHaveBeenCalled();
  });
});

describe('acknowledgeNotice', () => {
  it('fecha o aviso aberto → true, log só { jobPostingId, field }', async () => {
    const db = cli([{ id: 'n-1' }]);
    expect(await acknowledgeNotice(db, 'vac-1', 'schedule', 'staff:u-1')).toBe(true);
    expect(db.query.mock.calls[0][1]).toEqual(['vac-1', 'schedule', 'staff:u-1']);
    expect(mockInfo.mock.calls[0][0]).toEqual({ jobPostingId: 'vac-1', field: 'schedule' });
  });

  it('não havia aviso aberto → false, sem log', async () => {
    expect(await acknowledgeNotice(cli([]), 'vac-1', 'schedule', 'staff:u-1')).toBe(false);
    expect(mockInfo).not.toHaveBeenCalled();
  });
});
