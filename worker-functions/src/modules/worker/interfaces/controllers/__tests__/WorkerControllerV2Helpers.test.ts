/**
 * Helpers do WorkerControllerV2 — os ramos que o gate `revisao-pr` de 08/09/2026
 * flagrou com ZERO execução.
 *
 * O código novo do `PUT /me/general-info` (escrita confirmada) tinha 0% de unit:
 * `readFreshProgress` inteiro, os dois ramos, sem um único teste. Era exatamente
 * o comportamento que o conserto da D302 existe para entregar.
 */

import { readWorkerMissingFields } from '../../../infrastructure/WorkerCompletenessRepository';
import {
  withMissingFields,
  readFreshProgress,
  resolveWorkerIdByAuthUid,
  sendPersonalInfoFailure,
  UNCONFIRMED_WRITE,
  PHONE_NOT_AVAILABLE_MESSAGE,
} from '../WorkerControllerV2Helpers';
import { WORKER_ERROR_CODES } from '../../../domain/workerErrors';

const mockReportError = jest.fn();
jest.mock('@shared/logging', () => ({
  logger: { child: jest.fn().mockReturnValue({ warn: jest.fn(), info: jest.fn(), debug: jest.fn() }) },
  reportError: (...args: unknown[]) => mockReportError(...args),
}));

const poolWith = (impl: jest.Mock) => ({ query: impl }) as never;
const res = () => {
  const r: Record<string, jest.Mock> = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
};

beforeEach(() => jest.clearAllMocks());

describe('readWorkerMissingFields', () => {
  it('devolve a lista quando o banco responde', async () => {
    const q = jest.fn().mockResolvedValue({ rows: [{ missing: ['phone', 'title_certificate'] }] });
    await expect(readWorkerMissingFields(poolWith(q), 'w1')).resolves.toEqual([
      'phone',
      'title_certificate',
    ]);
  });

  it('devolve [] quando nada falta — array vazio é resposta legítima', async () => {
    const q = jest.fn().mockResolvedValue({ rows: [{ missing: [] }] });
    await expect(readWorkerMissingFields(poolWith(q), 'w1')).resolves.toEqual([]);
  });

  it('sem linha nenhuma → null ("não sei"), NUNCA []', async () => {
    // Ramo `rows.length === 0`: o gate mediu 0 execuções aqui. `[]` diria
    // "apurei e nada falta" para um worker sobre o qual não apuramos nada.
    const q = jest.fn().mockResolvedValue({ rows: [] });
    await expect(readWorkerMissingFields(poolWith(q), 'w1')).resolves.toBeNull();
  });

  it('coluna nula na resposta → null', async () => {
    const q = jest.fn().mockResolvedValue({ rows: [{ missing: null }] });
    await expect(readWorkerMissingFields(poolWith(q), 'w1')).resolves.toBeNull();
  });

  it('erro de banco → null, sem estourar a rota', async () => {
    const q = jest.fn().mockRejectedValue(new Error('db down'));
    await expect(readWorkerMissingFields(poolWith(q), 'w1')).resolves.toBeNull();
  });

  it('throw que NÃO é Error também vira null (ramo String(err))', async () => {
    // Ramo `err instanceof Error ? … : new Error(String(err))` — o gate mediu
    // o `else` com 0 execuções. `pg` pode rejeitar com string em alguns paths.
    const q = jest.fn().mockRejectedValue('boom');
    await expect(readWorkerMissingFields(poolWith(q), 'w1')).resolves.toBeNull();
  });
});

describe('withMissingFields', () => {
  it('anexa o veredito ao worker sem alterar o resto', async () => {
    const q = jest.fn().mockResolvedValue({ rows: [{ missing: ['phone'] }] });
    await expect(withMissingFields(poolWith(q), { id: 'w1', email: 'a@b.c' })).resolves.toEqual({
      id: 'w1',
      email: 'a@b.c',
      missingFields: ['phone'],
    });
  });

  it('propaga null quando não foi possível apurar', async () => {
    const q = jest.fn().mockRejectedValue(new Error('x'));
    const out = await withMissingFields(poolWith(q), { id: 'w1' });
    expect(out.missingFields).toBeNull();
  });
});

describe('readFreshProgress — a escrita confirmada', () => {
  it('devolve o worker relido COM missingFields (caminho feliz)', async () => {
    // Era o ramo `branch 263 = [0,0]` do relatório do gate.
    const q = jest.fn().mockResolvedValue({ rows: [{ missing: [] }] });
    const reread = jest.fn().mockResolvedValue({ id: 'w1', phone: '+5491151265663' });

    const out = await readFreshProgress(poolWith(q), reread, 'auth-1');

    expect(out).toEqual({ id: 'w1', phone: '+5491151265663', missingFields: [] });
    expect(reread).toHaveBeenCalledTimes(1);
  });

  it('releitura sem worker → UNCONFIRMED_WRITE e ALGUÉM É AVISADO', async () => {
    const q = jest.fn();
    const out = await readFreshProgress(poolWith(q), jest.fn().mockResolvedValue(null), 'auth-1');

    expect(out).toEqual(UNCONFIRMED_WRITE);
    expect(out).toHaveProperty('missingFields', null);
    // O gate reprovou este ramo por engolir a falha em silêncio: a mesma leitura
    // acabou de suceder nesta request, então falhar aqui é anomalia real. Sem
    // reportError ninguém acorda — o cliente recebe 200 e o dado ficou incerto.
    expect(mockReportError).toHaveBeenCalledTimes(1);
  });

  it('releitura que ESTOURA → UNCONFIRMED_WRITE e reportError', async () => {
    const q = jest.fn();
    const reread = jest.fn().mockRejectedValue(new Error('db down'));

    const out = await readFreshProgress(poolWith(q), reread, 'auth-1');

    expect(out).toEqual(UNCONFIRMED_WRITE);
    expect(mockReportError).toHaveBeenCalledTimes(1);
  });

  it('releitura que estoura com NÃO-Error → mesmo contrato (ramo String(err))', async () => {
    const reread = jest.fn().mockRejectedValue('boom');
    const out = await readFreshProgress(poolWith(jest.fn()), reread, 'auth-1');
    expect(out).toEqual(UNCONFIRMED_WRITE);
    expect(mockReportError).toHaveBeenCalledTimes(1);
  });

  it('UNCONFIRMED_WRITE nunca diz que está completo', () => {
    // Trava de contrato: `[]` aqui significaria "nada falta" para uma escrita
    // que não conseguimos confirmar.
    expect(UNCONFIRMED_WRITE.missingFields).toBeNull();
    expect(UNCONFIRMED_WRITE.missingFields).not.toEqual([]);
  });
});

describe('resolveWorkerIdByAuthUid', () => {
  it('devolve só o id, sem tocar em coluna encriptada', async () => {
    const q = jest.fn().mockResolvedValue({ rows: [{ id: 'w1' }] });
    await expect(resolveWorkerIdByAuthUid(poolWith(q), 'auth-1')).resolves.toBe('w1');

    const sql = q.mock.calls[0][0] as string;
    // O ponto do helper é NÃO pagar os 9 decrypts KMS do findByAuthUid num
    // endpoint que é autosave por blur.
    expect(sql).not.toMatch(/_encrypted/);
    expect(sql).toMatch(/w\.auth_uid = \$1/);
  });

  it('sem worker → null', async () => {
    const q = jest.fn().mockResolvedValue({ rows: [] });
    await expect(resolveWorkerIdByAuthUid(poolWith(q), 'auth-1')).resolves.toBeNull();
  });

  it('erro de banco → null e reportError', async () => {
    const q = jest.fn().mockRejectedValue(new Error('db down'));
    await expect(resolveWorkerIdByAuthUid(poolWith(q), 'auth-1')).resolves.toBeNull();
    expect(mockReportError).toHaveBeenCalledTimes(1);
  });

  it('throw que NÃO é Error também vira null (ramo String(err))', async () => {
    const q = jest.fn().mockRejectedValue('boom');
    await expect(resolveWorkerIdByAuthUid(poolWith(q), 'auth-1')).resolves.toBeNull();
    expect(mockReportError).toHaveBeenCalledTimes(1);
  });
});

describe('readFreshProgress — authUid ausente no log', () => {
  it('não estoura quando authUid vem vazio', async () => {
    // `Boolean(authUid)` no log: o ramo falso nunca tinha sido exercido. O log
    // registra a PRESENÇA, nunca o valor — authUid não vai para log por ser
    // identificador de pessoa.
    const out = await readFreshProgress(poolWith(jest.fn()), jest.fn().mockResolvedValue(null), '');
    expect(out).toEqual(UNCONFIRMED_WRITE);
  });
});

describe('sendPersonalInfoFailure', () => {
  it('PHONE_NOT_AVAILABLE vira 409 com code, sem revelar de quem é o número', () => {
    const r = res();
    sendPersonalInfoFailure(r as never, WORKER_ERROR_CODES.PHONE_NOT_AVAILABLE);

    expect(r.status).toHaveBeenCalledWith(409);
    const body = r.json.mock.calls[0][0];
    expect(body.code).toBe(WORKER_ERROR_CODES.PHONE_NOT_AVAILABLE);
    expect(body.error).toBe(PHONE_NOT_AVAILABLE_MESSAGE);
    expect(JSON.stringify(body)).not.toMatch(/outra conta|another account|idx_workers_phone_unique/i);
  });

  it('qualquer outro erro cai no 400 genérico', () => {
    const r = res();
    sendPersonalInfoFailure(r as never, 'Failed to update personal info: boom');
    expect(r.status).toHaveBeenCalledWith(400);
  });
});
