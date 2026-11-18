const mockResolve = jest.fn();
let ctxKind: 'staff' | 'system' = 'staff';
jest.mock('@modules/identity/application/resolveCountryScope', () => ({
  resolveCountryScope: (...a: unknown[]) => mockResolve(...a),
  CountryScopeError: class CountryScopeError extends Error {
    constructor(public status: number, public code: string, m: string) { super(m); }
  },
}));
jest.mock('@shared/database/requestDbSession', () => ({ currentDbContext: () => (ctxKind === 'staff' ? { kind: 'staff', uid: 'u1' } : { kind: 'system' }) }));
jest.mock('@shared/logging', () => ({ reportError: jest.fn() }));

import { requirePatientInCountryScope } from '../patientCountryScopeGuard';
import { CountryScopeError } from '@modules/identity/application/resolveCountryScope';

const ID = '11111111-1111-4111-8111-111111111111';

function run(params: Record<string, string>, rows: Array<{ country: string }>) {
  const query = jest.fn().mockResolvedValue({ rows });
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  const done = requirePatientInCountryScope(() => ({ query }) as never)({ params } as never, res, next);
  return { query, res, next, done };
}

describe('requirePatientInCountryScope', () => {
  beforeEach(() => mockResolve.mockReset());

  it('paciente BR com escopo [AR] => 404 "Patient not found" e next NAO chamado', async () => {
    mockResolve.mockResolvedValue({ countries: ['AR'], requested: 'ALL' });
    const t = run({ id: ID }, [{ country: 'BR' }]);
    await t.done;
    expect(mockResolve).toHaveBeenCalledWith(expect.anything(), 'u1', undefined);
    expect(t.res.status).toHaveBeenCalledWith(404);
    expect(t.res.json).toHaveBeenCalledWith({ success: false, error: 'Patient not found' });
    expect(t.next).not.toHaveBeenCalled();
  });

  it('paciente AR com escopo [AR] segue (country bpchar com espaco tambem)', async () => {
    mockResolve.mockResolvedValue({ countries: ['AR'], requested: 'ALL' });
    const t = run({ patientId: ID }, [{ country: 'AR ' }]);
    await t.done;
    expect(t.next).toHaveBeenCalledTimes(1);
    expect(t.res.status).not.toHaveBeenCalled();
  });

  it('escopo [AR,BR] enxerga BR', async () => {
    mockResolve.mockResolvedValue({ countries: ['AR', 'BR'], requested: 'ALL' });
    const t = run({ id: ID }, [{ country: 'BR' }]);
    await t.done;
    expect(t.next).toHaveBeenCalledTimes(1);
  });

  it('usuario sem pais => erro do resolveCountryScope (403 COUNTRY_SCOPE_REQUIRED), sem consultar o paciente', async () => {
    mockResolve.mockRejectedValue(new (CountryScopeError as any)(403, 'COUNTRY_SCOPE_REQUIRED', 'sem pais'));
    const t = run({ id: ID }, [{ country: 'AR' }]);
    await t.done;
    expect(t.res.status).toHaveBeenCalledWith(403);
    expect(t.res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'COUNTRY_SCOPE_REQUIRED' }));
    expect(t.next).not.toHaveBeenCalled();
  });

  it('id inexistente segue (handler responde o 404 dele); id nao-UUID segue sem consulta', async () => {
    mockResolve.mockResolvedValue({ countries: ['AR'], requested: 'ALL' });
    const a = run({ id: ID }, []);
    await a.done;
    expect(a.next).toHaveBeenCalledTimes(1);
    const b = run({ id: 'stats' }, []);
    await b.done;
    expect(b.next).toHaveBeenCalledTimes(1);
    expect(b.query).not.toHaveBeenCalled();
  });

  it('principal de servico (API key, kind=system) passa direto, sem resolver escopo', async () => {
    ctxKind = 'system';
    const t = run({ id: ID }, [{ country: 'BR' }]);
    await t.done;
    ctxKind = 'staff';
    expect(t.next).toHaveBeenCalledTimes(1);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('falha inesperada => 500 fechado, nunca next', async () => {
    mockResolve.mockRejectedValue(new Error('db down'));
    const t = run({ id: ID }, []);
    await t.done;
    expect(t.res.status).toHaveBeenCalledWith(500);
    expect(t.next).not.toHaveBeenCalled();
  });
});
