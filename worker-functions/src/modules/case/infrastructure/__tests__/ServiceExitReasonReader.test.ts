/**
 * ServiceExitReasonReader — leitura do catálogo de motivos de saída (migration 492).
 * Pool falso na fronteira; o SQL de verdade é provado no e2e `service-exit-reasons-catalog`.
 */
import { ServiceExitReasonReader } from '../ServiceExitReasonReader';

const cliente = (rows: unknown[]) => ({ query: jest.fn().mockResolvedValue({ rows }) });

describe('ServiceExitReasonReader', () => {
  it('findActiveByCode: filtra `active` e o código por parâmetro; devolve { code, label }', async () => {
    const cli = cliente([{ code: 'OTHER', label: 'Otro' }]);
    const r = await new ServiceExitReasonReader().findActiveByCode(cli as never, 'OTHER');
    expect(r).toEqual({ code: 'OTHER', label: 'Otro' });
    const [sql, params] = cli.query.mock.calls[0];
    expect(sql).toContain('FROM service_exit_reasons');
    expect(sql).toContain('active AND code = $1');
    expect(params).toEqual(['OTHER']);
  });

  it('findActiveByCode: inexistente ou inativo → null', async () => {
    const r = await new ServiceExitReasonReader().findActiveByCode(cliente([]) as never, 'NAO_EXISTE');
    expect(r).toBeNull();
  });

  it('listActiveOptions: só ativos, por sort_order e lower(label)', async () => {
    const linhas = [{ code: 'A', label: 'a' }, { code: 'B', label: 'b' }];
    const cli = cliente(linhas);
    const r = await new ServiceExitReasonReader().listActiveOptions(cli as never);
    expect(r).toEqual(linhas);
    const sql = cli.query.mock.calls[0][0] as string;
    expect(sql).toContain('WHERE active');
    expect(sql).toContain('ORDER BY sort_order, lower(label)');
  });
});
