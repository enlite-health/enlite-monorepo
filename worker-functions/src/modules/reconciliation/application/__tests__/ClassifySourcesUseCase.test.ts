/**
 * ClassifySourcesUseCase — H1 passo 2: links por pessoa; ambíguo vai para a
 * fila e NUNCA é fundido; rodada PARTIAL não infere ausência; task do ClickUp
 * bate primeiro por clickup_task_id (EXTERNAL_ID).
 *
 * Controle positivo (T017, D157): o teste "ambíguo nunca fundido" precisa
 * ficar VERMELHO se alguém trocar AMBIGUOUS por AUTO com patient_id — o
 * spy em upsertAutomatic é a régua; sabotar o use case derruba a asserção.
 * Fixture sintética.
 */
// ── Mocks (before imports) ──
jest.mock('@shared/logging', () => ({
  logger: { child: jest.fn().mockReturnValue({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) },
  reportError: jest.fn(),
  loggingAls: { run: jest.fn() },
}));

import { ClassifySourcesUseCase } from '../ClassifySourcesUseCase';
import type { CanonicalPatient } from '../../domain/CanonicalPatient';
import type { SnapshotRow } from '../../infrastructure/SnapshotRepository';

const canon = (over: Partial<CanonicalPatient>): CanonicalPatient => ({
  firstName: null, lastName: null, birthDate: null, documentType: null, documentNumber: null, sex: null,
  phoneWhatsapp: null, healthInsuranceName: null, healthInsuranceMemberId: null, hasCud: null, hasConsent: null,
  hasJudicialProtection: null, diagnosis: null, dependencyLevel: null, clinicalSpecialty: null, serviceType: null,
  additionalComments: null, province: null, cityLocality: null, zoneNeighborhood: null, addresses: [],
  multidisciplinaryTeam: null, caseNumber: null, status: null, responsibleFirstName: null, responsibleLastName: null,
  responsibleRelationship: null, country: 'AR', ...over,
});

const snap = (source: 'CLICKUP' | 'ANACARE', externalId: string, c: Partial<CanonicalPatient>): SnapshotRow => ({
  id: `s-${externalId}`, runId: `run-${source}`, source, country: 'AR', externalId, canonical: canon(c), contentHash: 'h', readAt: new Date(),
});

const platform = [
  { patientId: 'p-ana', firstName: 'Ana María', lastName: 'Pérez', birthDate: '2015-03-04', documentType: 'DNI', documentNumber: '12345678', clickupTaskId: 'task-ana', anaCareId: 'ac-ana' },
  { patientId: 'p-bruno', firstName: 'Bruno', lastName: 'Silva', birthDate: '2010-01-01', documentType: null, documentNumber: null, clickupTaskId: 'task-bruno', anaCareId: null },
];

function build(opts: { clickup?: SnapshotRow[]; anacare?: SnapshotRow[]; clickupCompleteness?: 'COMPLETE' | 'PARTIAL'; denied?: Record<string, string[]> }) {
  const runs = {
    findLatestUsable: jest.fn().mockImplementation(async (source: string) => {
      if (source === 'CLICKUP' && opts.clickup) return { id: 'run-CLICKUP', source, country: 'AR', completeness: opts.clickupCompleteness ?? 'COMPLETE' };
      if (source === 'ANACARE' && opts.anacare) return { id: 'run-ANACARE', source, country: 'AR', completeness: 'COMPLETE' };
      return null;
    }),
  };
  const snapshots = { latestBySource: jest.fn().mockImplementation(async (source: string) => (source === 'CLICKUP' ? opts.clickup : opts.anacare) ?? []) };
  const links = {
    identityCandidates: jest.fn().mockResolvedValue(platform),
    deniedPatientIds: jest.fn().mockImplementation(async (_s: string, ext: string) => new Set(opts.denied?.[ext] ?? [])),
    upsertAutomatic: jest.fn().mockImplementation(async (input: unknown) => ({ id: 'l', ...(input as object) })),
    inventoryCounts: jest.fn().mockResolvedValue({ onlyClickup: 0, onlyAnacare: 0, both: 0, ambiguous: 0, total: 0 }),
  };
  return { uc: new ClassifySourcesUseCase({ runs, snapshots, links }), runs, snapshots, links };
}

describe('ClassifySourcesUseCase', () => {
  it('ClickUp: a task bate por clickup_task_id → EXTERNAL_ID, antes de qualquer heurística', async () => {
    const { uc, links } = build({ clickup: [snap('CLICKUP', 'task-bruno', { firstName: 'Nome', lastName: 'Trocado' })] });
    await uc.execute({ country: 'AR' });
    expect(links.upsertAutomatic).toHaveBeenCalledWith(expect.objectContaining({ source: 'CLICKUP', externalId: 'task-bruno', patientId: 'p-bruno', matchKey: 'EXTERNAL_ID', state: 'AUTO' }));
  });

  it('Ana Care: ana_care_id bate → EXTERNAL_ID, simétrico ao ClickUp (migration 300)', async () => {
    const { uc, links } = build({ anacare: [snap('ANACARE', 'ac-ana', { firstName: 'Outro', lastName: 'Nome' })] });
    await uc.execute({ country: 'AR' });
    expect(links.upsertAutomatic).toHaveBeenCalledWith(expect.objectContaining({ source: 'ANACARE', externalId: 'ac-ana', patientId: 'p-ana', matchKey: 'EXTERNAL_ID', state: 'AUTO' }));
  });

  it('Ana Care: documento igual → AUTO/DOCUMENT; nome+nascimento → AUTO/NAME_BIRTHDATE; nada → AUTO/NONE sem pessoa', async () => {
    const { uc, links } = build({ anacare: [
      snap('ANACARE', 'a1', { firstName: 'ana maria', lastName: 'perez', documentType: 'dni', documentNumber: '12.345.678' }),
      snap('ANACARE', 'a2', { firstName: 'Bruno', lastName: 'Silva', birthDate: '2010-01-01' }),
      snap('ANACARE', 'a3', { firstName: 'Zé', lastName: 'Novo', birthDate: '2001-01-01' }),
    ] });
    const r = await uc.execute({ country: 'AR' });
    expect(links.upsertAutomatic).toHaveBeenCalledWith(expect.objectContaining({ externalId: 'a1', patientId: 'p-ana', matchKey: 'DOCUMENT', state: 'AUTO' }));
    expect(links.upsertAutomatic).toHaveBeenCalledWith(expect.objectContaining({ externalId: 'a2', patientId: 'p-bruno', matchKey: 'NAME_BIRTHDATE', state: 'AUTO' }));
    expect(links.upsertAutomatic).toHaveBeenCalledWith(expect.objectContaining({ externalId: 'a3', patientId: null, matchKey: 'NONE', state: 'AUTO' }));
    expect(r.perSource.ANACARE).toEqual({ matched: 2, ambiguous: 0, unmatched: 1, partial: false });
  });

  it('bate em parte → AMBIGUOUS com candidato e patient_id NULL — NUNCA fundido (controle T017)', async () => {
    const { uc, links } = build({ anacare: [snap('ANACARE', 'amb', { firstName: 'Bruno', lastName: 'Silva', birthDate: '2011-01-01' })] });
    const r = await uc.execute({ country: 'AR' });
    const call = links.upsertAutomatic.mock.calls[0][0] as { state: string; patientId: string | null; candidatePatientId?: string };
    expect(call.state).toBe('AMBIGUOUS');
    expect(call.patientId).toBeNull();
    expect(call.candidatePatientId).toBe('p-bruno');
    expect(r.perSource.ANACARE?.ambiguous).toBe(1);
  });

  it('DENIED persiste: candidato negado não volta por chave forte', async () => {
    const { uc, links } = build({
      anacare: [snap('ANACARE', 'a1', { firstName: 'Ana María', lastName: 'Pérez', documentType: 'DNI', documentNumber: '12345678' })],
      denied: { a1: ['p-ana'] },
    });
    await uc.execute({ country: 'AR' });
    expect(links.upsertAutomatic).toHaveBeenCalledWith(expect.objectContaining({ externalId: 'a1', patientId: null, matchKey: 'NONE' }));
  });

  it('rodada PARTIAL classifica o que leu e marca partial — nenhum link é dado como ausente', async () => {
    const { uc, links, runs } = build({ clickup: [snap('CLICKUP', 'task-ana', {})], clickupCompleteness: 'PARTIAL' });
    const r = await uc.execute({ country: 'AR' });
    expect(r.perSource.CLICKUP?.partial).toBe(true);
    expect(links.upsertAutomatic).toHaveBeenCalledTimes(1);
    // nenhuma chamada que marque ausência/DENIED/deleção existe na porta do use case
    expect(Object.keys(links)).not.toContain('markAbsent');
    expect(runs.findLatestUsable).toHaveBeenCalledWith('ANACARE', 'AR');
  });

  it('fonte sem rodada usável é pulada (H1 roda parcial só com ClickUp)', async () => {
    const { uc, snapshots } = build({ clickup: [] });
    const r = await uc.execute({ country: 'AR' });
    expect(r.runs.ANACARE).toBeUndefined();
    expect(snapshots.latestBySource).toHaveBeenCalledTimes(1);
  });
});
