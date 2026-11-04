import { logger } from '@shared/logging';
import { LuzPruebaController } from '../LuzPruebaController';
import { TriageIndisponivel } from '../../../domain/TriagePruebaPort';

const req = () => ({ authContext: { principal: { id: 'uid-1' } }, body: { sessao: 's1', mensagem: 'texto-secreto', historico: [] } }) as never;
const res = () => {
  const r: Record<string, jest.Mock> = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r as unknown as import('express').Response & { status: jest.Mock; json: jest.Mock };
};

describe('LuzPruebaController — logs de erro (RF-8 / D587)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('triage cai E a devolução da cota também falha: loga DEVOLUCAO_COTA_FALHOU e TRIAGE_INDISPONIVEL:<causa>, só {uid_hash, sessao, codigo}, e responde 502', async () => {
    const erro = jest.spyOn(logger, 'error').mockImplementation((() => undefined) as never);
    const turnos = { consumir: jest.fn().mockResolvedValue({ permitido: true, turnos: 1 }), devolver: jest.fn().mockRejectedValue(new Error('segredo-do-driver')) };
    const triage = { turno: jest.fn().mockRejectedValue(new TriageIndisponivel('timeout')) };
    const r = res();
    await new LuzPruebaController(triage, turnos, 60).turn(req(), r);
    expect(r.status).toHaveBeenCalledWith(502);
    expect(r.json).toHaveBeenCalledWith({ codigo: 'TRIAGE_INDISPONIVEL' });
    const campos = erro.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(campos.map((c) => c.codigo)).toEqual(['DEVOLUCAO_COTA_FALHOU', 'TRIAGE_INDISPONIVEL:timeout']);
    for (const c of campos) expect(Object.keys(c).sort()).toEqual(['codigo', 'sessao', 'uid_hash']);
    expect(JSON.stringify(erro.mock.calls)).not.toMatch(/segredo-do-driver|texto-secreto|uid-1/);
  });

  it('contador falha: 500 e codigo CONTADOR_FALHOU:<nome do erro> (nunca a mensagem)', async () => {
    const erro = jest.spyOn(logger, 'error').mockImplementation((() => undefined) as never);
    class PgBoom extends Error { constructor() { super('detalhe com dado'); this.name = 'PgBoom'; } }
    const turnos = { consumir: jest.fn().mockRejectedValue(new PgBoom()), devolver: jest.fn() };
    const r = res();
    await new LuzPruebaController({ turno: jest.fn() }, turnos, 60).turn(req(), r);
    expect(r.status).toHaveBeenCalledWith(500);
    expect((erro.mock.calls[0][0] as Record<string, unknown>).codigo).toBe('CONTADOR_FALHOU:PgBoom');
    expect(JSON.stringify(erro.mock.calls)).not.toContain('detalhe com dado');
  });
});
