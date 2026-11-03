import { WorkerByPhoneCapability } from '../WorkerByPhoneCapability';
import { AGENT_CAPABILITY_CELLS } from '../../../domain/AgentCapabilityCells';
import { McpAuditLogger } from '../../../infrastructure/McpAuditLogger';

const WID = '11111111-1111-4111-8111-111111111111';
const FONE = '+5491155551234';

function montar(found = true) {
  const trail = { record: jest.fn(async () => undefined) };
  const lookup = { findByPhone: jest.fn(async () => (found ? { workerId: WID, data: { id: WID, status: 'REGISTERED' } } : null)) };
  return { cap: new WorkerByPhoneCapability(lookup, trail), trail, lookup };
}

describe('WorkerByPhoneCapability (worker.byPhone, decisão 4 do lote 0)', () => {
  it('achou: devolve a ficha e grava a trilha com o UUID do prestador, o operador e a ação read_by_phone — NUNCA o telefone', async () => {
    const m = montar();
    const r = await m.cap.execute({ phone: FONE }, 'agent:luz');
    expect(r).toEqual({ found: true, worker: { id: WID, status: 'REGISTERED' } });
    expect(m.trail.record).toHaveBeenCalledTimes(1);
    expect(m.trail.record).toHaveBeenCalledWith({ operatorUid: 'agent:luz', workerId: WID, action: 'read_by_phone' });
    expect(JSON.stringify(m.trail.record.mock.calls)).not.toContain('5491155551234');
  });

  it('não achou: {found:false} e nenhuma trilha (tentativa frustrada não é acesso)', async () => {
    const m = montar(false);
    await expect(m.cap.execute({ phone: FONE }, 'agent:luz')).resolves.toEqual({ found: false });
    expect(m.trail.record).not.toHaveBeenCalled();
  });

  it('falha na trilha não derruba a leitura (fail-safe, como o logResourceAccess do REST)', async () => {
    const m = montar();
    m.trail.record.mockRejectedValueOnce(new Error('x'));
    await expect(m.cap.execute({ phone: FONE }, 'agent:luz')).resolves.toMatchObject({ found: true });
  });

  it('argumento inválido (sem phone / phone curto) é recusado antes de consultar', async () => {
    const m = montar();
    await expect(m.cap.execute({}, 'agent:luz')).rejects.toThrow();
    await expect(m.cap.execute({ phone: '12' }, 'agent:luz')).rejects.toThrow();
    expect(m.lookup.findByPhone).not.toHaveBeenCalled();
  });

  it('a célula é worker_pii:read (a da rota REST irmã) e o telefone sai MASCARADO no log de auditoria do MCP (arg `phone`)', () => {
    expect(AGENT_CAPABILITY_CELLS[WorkerByPhoneCapability.NAME]).toBe('worker_pii:read');
    expect(new McpAuditLogger().redact({ phone: FONE })).toEqual({ phone: '***1234' });
  });
});
