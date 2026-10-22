/**
 * Spec 064 — `currentCoverage` e `entryDate` na ficha: derivados SOBRE os serviços já projetados
 * para o ator (ordem importa: derivar do cru vazaria o nome da obra social a quem não lê `coverage`).
 */
import { projectAdminPatientDetail } from '../AdminPatientView';

const service = (over: Record<string, unknown>) => ({
  liveVacancy: null,
  payerHistory: [],
  price: { state: 'NO_CONTRACT' },
  coverageMatch: { state: 'MATCH' },
  ...over,
});

const ficha = () => ({
  id: 'p1',
  contractedServices: [
    service({
      id: 's1', active: true, startDate: '2025-04-01',
      payer: { state: 'LINKED', isPrivate: false, validFrom: '2025-04-01', validTo: null, names: { providerCode: 'OSDE', providerName: 'OSDE', contractId: 'c1', contractName: 'Plan', payerKind: 'INSURER' } },
    }),
    service({
      id: 's2', active: false, startDate: '2024-02-15',
      payer: { state: 'NO_CONTRACT' },
    }),
  ],
});

const admin = { cells: null, roles: ['admin'] } as const;

describe('projectAdminPatientDetail — currentCoverage / entryDate (spec 064)', () => {
  it('ator lê tudo: currentCoverage com o nome da obra social e entryDate', () => {
    const out = projectAdminPatientDetail(ficha(), null, admin) as Record<string, unknown>;
    expect(out.currentCoverage).toEqual({
      providers: [{ code: 'OSDE', name: 'OSDE' }],
      privateServices: 0, hiddenServices: 0, unlinkedServices: 0, activeServices: 1,
    });
    expect(out.entryDate).toBe('2024-02-15');
  });

  it('ator lê services mas NÃO coverage: provedor não aparece, hiddenServices conta', () => {
    const cells = ['patient:read', 'patient_services:read'];
    const out = projectAdminPatientDetail(ficha(), cells, { cells, roles: ['recruiter'] }) as Record<string, unknown>;
    expect(out.currentCoverage).toEqual({
      providers: [], privateServices: 0, hiddenServices: 1, unlinkedServices: 0, activeServices: 1,
    });
    expect(JSON.stringify(out)).not.toContain('OSDE');
    expect(out.entryDate).toBe('2024-02-15');
  });

  it('ator sem a célula services: ambos null e redacted.services true', () => {
    const cells = ['patient:read', 'patient_coverage:read'];
    const out = projectAdminPatientDetail(ficha(), cells, { cells, roles: ['recruiter'] }) as Record<string, unknown>;
    expect(out.currentCoverage).toBeNull();
    expect(out.entryDate).toBeNull();
    expect(out.redacted).toHaveProperty('services', true);
  });

  it('o resultado é o mesmo agregado para ator que lê tudo e a lista de serviços mostrada', () => {
    const out = projectAdminPatientDetail(ficha(), null, admin) as {
      currentCoverage: { activeServices: number };
      contractedServices: { active: boolean }[];
    };
    expect(out.currentCoverage.activeServices).toBe(out.contractedServices.filter((s) => s.active).length);
  });
});
