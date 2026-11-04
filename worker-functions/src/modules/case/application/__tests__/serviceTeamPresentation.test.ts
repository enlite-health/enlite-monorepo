/**
 * serviceTeamPresentation — gate parcial #4/#5. `projectServiceTeamDisplayNames` e
 * `buildServiceTeamResult` são o módulo único que os dois casos de uso (GET e o recompute de
 * reject/revert) agora chamam — este arquivo prova o módulo isoladamente, sem duplicar os testes
 * de comportamento de domínio que já vivem em `GetServiceTeamUseCase.test.ts`/`ServiceTeamMarkUseCase.test.ts`.
 */
import { projectServiceTeamDisplayNames, buildServiceTeamResult, deriveServiceTeamFromRows } from '../serviceTeamPresentation';
import type { ServiceTeamRows } from '../../infrastructure/ServiceTeamReader';
import { deriveServiceTeam, SERVICE_TEAM_ENTRY_STAGE, type DeriveServiceTeamResult } from '../../domain/deriveServiceTeam';
import { CELL_WORKER_CONTACT_READ, type Decryptor } from '@modules/identity/permissions';

function kmsSpy(): { kms: Decryptor; decrypt: jest.Mock } {
  const decrypt = jest.fn(async (c?: string | null) => String(c ?? '').replace(/^enc:/, ''));
  return { kms: { decrypt }, decrypt };
}

/**
 * `row` traz o HISTÓRICO inteiro que o leitor devolve (achado #5: `alloc` não filtra por status) —
 * `w-historico` só aparece em `assignments` (uma alocação ANTIGA, já encerrada) e não entra em
 * nenhuma das 3 listas derivadas abaixo. `w-selected`/`w-inservice`/`w-rejected` são os 3
 * prestadores DISTINTOS que a derivação realmente produziu.
 */
function rowComHistorico(): ServiceTeamRows {
  return {
    serviceId: 's-1',
    country: 'AR',
    liveVacancyId: 'v-live',
    candidacies: [
      { workerId: 'w-selected', vacancyId: 'v-live', stage: 'QUICK_RESPONSE_TEAM', firstNameEncrypted: 'enc:Selected', lastNameEncrypted: null },
    ],
    assignments: [
      { workerId: 'w-inservice', serviceId: 's-1', vacancyId: 'v-old', validFrom: '2026-09-01', validTo: null, status: 'ACTIVE', firstNameEncrypted: 'enc:InService', lastNameEncrypted: null },
      { workerId: 'w-historico', serviceId: 's-1', vacancyId: 'v-ancient', validFrom: '2020-01-01', validTo: '2020-06-01', status: 'ENDED', firstNameEncrypted: 'enc:Historico', lastNameEncrypted: null },
    ],
    marks: [
      { workerId: 'w-rejected', serviceId: 's-1', rejectReasonCategory: 'OTHER', firstNameEncrypted: 'enc:Rejected', lastNameEncrypted: null },
    ],
  };
}

/** O time DERIVADO correspondente a `rowComHistorico()` — `w-historico` fica de fora das 3. */
const TEAM_DERIVADO_ASOF = '2026-09-28';
function teamDerivado(): DeriveServiceTeamResult & { asOf: string } {
  return {
    selected: [{ workerId: 'w-selected', vacancyId: 'v-live' }],
    inService: [{ workerId: 'w-inservice', vacancyId: 'v-old' }],
    rejected: [{ workerId: 'w-rejected', reasonCategory: 'OTHER' }],
    asOf: TEAM_DERIVADO_ASOF,
  };
}

describe('projectServiceTeamDisplayNames', () => {
  it('nome: decifra e junta primeiro+último por prestador das 3 listas derivadas', async () => {
    const { kms } = kmsSpy();
    const result = await projectServiceTeamDisplayNames(rowComHistorico(), teamDerivado(), [CELL_WORKER_CONTACT_READ], kms);
    expect(result.get('w-selected')).toBe('Selected');
    expect(result.get('w-inservice')).toBe('InService');
    expect(result.get('w-rejected')).toBe('Rejected');
  });

  it('cells === null (engine OFF) → como hoje, o nome aparece', async () => {
    const { kms } = kmsSpy();
    const result = await projectServiceTeamDisplayNames(rowComHistorico(), teamDerivado(), null, kms);
    expect(result.get('w-selected')).toBe('Selected');
    expect(result.get('w-inservice')).toBe('InService');
    expect(result.get('w-rejected')).toBe('Rejected');
  });

  it('cells sem worker_contact:read → displayName null e 0 chamadas ao KMS (a célula decide ANTES do KMS)', async () => {
    const { kms, decrypt } = kmsSpy();
    const result = await projectServiceTeamDisplayNames(rowComHistorico(), teamDerivado(), ['worker:read'], kms);
    expect(decrypt).toHaveBeenCalledTimes(0);
    expect(result.get('w-selected')).toBeNull();
    expect(result.get('w-inservice')).toBeNull();
    expect(result.get('w-rejected')).toBeNull();
  });

  it('N prestadores distintos → N decrypts (1 por prestador, em paralelo)', async () => {
    const { kms, decrypt } = kmsSpy();
    await projectServiceTeamDisplayNames(rowComHistorico(), teamDerivado(), [CELL_WORKER_CONTACT_READ], kms);
    // 3 prestadores nas listas derivadas, cada um com só o primeiro nome (lastNameEncrypted null) →
    // 1 decrypt de firstName + 1 de lastName (null, resolve sem tocar `abrir`... mas `abrir` retorna
    // cedo pra null sem chamar kms.decrypt) — o par decifrado por prestador é [primeiro, ultimo,
    // whatsapp]; ultimo e whatsapp são null aqui e `abrir` não chama `decrypt` para valor null/undefined.
    // Logo: 1 chamada de decrypt por prestador (o firstName), 3 no total.
    expect(decrypt).toHaveBeenCalledTimes(3);
  });

  it('prestador só no HISTÓRICO (fora das 3 listas derivadas) → 0 decrypt para ele — a régua do achado #5', async () => {
    const { kms, decrypt } = kmsSpy();
    const result = await projectServiceTeamDisplayNames(rowComHistorico(), teamDerivado(), [CELL_WORKER_CONTACT_READ], kms);

    expect(result.has('w-historico')).toBe(false);
    // Nenhuma chamada de decrypt recebeu o ciphertext do prestador histórico ('enc:Historico').
    const ciphertextsDecifrados = decrypt.mock.calls.map((call) => call[0]);
    expect(ciphertextsDecifrados).not.toContain('enc:Historico');
    // Só 3 prestadores DERIVADOS decifrados — o histórico (4º nome no `row`) não conta.
    expect(decrypt).toHaveBeenCalledTimes(3);
  });

  it('time vazio (3 listas derivadas vazias) → 0 decrypt, mesmo com histórico no row', async () => {
    const { kms, decrypt } = kmsSpy();
    const vazio: DeriveServiceTeamResult = { selected: [], inService: [], rejected: [] };
    const result = await projectServiceTeamDisplayNames(rowComHistorico(), vazio, [CELL_WORKER_CONTACT_READ], kms);
    expect(result.size).toBe(0);
    expect(decrypt).toHaveBeenCalledTimes(0);
  });
});

describe('buildServiceTeamResult', () => {
  it('monta as 3 listas com displayName por worker, vacancyId da candidatura/alocação, e a vaga viva em rejected', () => {
    const displayNameByWorkerId = new Map<string, string | null>([
      ['w-selected', 'Selected'],
      ['w-inservice', 'InService'],
      ['w-rejected', 'Rejected'],
    ]);
    const result = buildServiceTeamResult({ serviceId: 's-1', liveVacancyId: 'v-live', candidacies: [] }, teamDerivado(), displayNameByWorkerId);

    expect(result.serviceId).toBe('s-1');
    expect(result.vacancyId).toBe('v-live');
    expect(result.asOf).toBe(TEAM_DERIVADO_ASOF);
    expect(result.selected).toEqual([{ workerId: 'w-selected', displayName: 'Selected', vacancyId: 'v-live' }]);
    expect(result.inService).toEqual([{ workerId: 'w-inservice', displayName: 'InService', vacancyId: 'v-old' }]);
    expect(result.rejected).toEqual([{ workerId: 'w-rejected', displayName: 'Rejected', vacancyId: 'v-live', reasonCategory: 'OTHER' }]);
  });

  it('Fase 2 (D2): rótulo do catálogo em `row.marks` vira `reasonLabel` no rejeitado; sem rótulo, a chave nem existe (a tela cai em reasonCategory)', () => {
    const nomes = new Map<string, string | null>([['w-rejected', 'Rejected']]);
    const comRotulo = buildServiceTeamResult(
      {
        serviceId: 's-1',
        liveVacancyId: 'v-live',
        candidacies: [],
        marks: [{ workerId: 'w-rejected', serviceId: 's-1', rejectReasonCategory: 'OTHER', rejectReasonLabel: 'Otro', firstNameEncrypted: null, lastNameEncrypted: null }],
      },
      teamDerivado(),
      nomes,
    );
    expect(comRotulo.rejected[0].reasonLabel).toBe('Otro');

    const semRotulo = buildServiceTeamResult({ serviceId: 's-1', liveVacancyId: 'v-live', candidacies: [], marks: [] }, teamDerivado(), nomes);
    expect(semRotulo.rejected[0]).not.toHaveProperty('reasonLabel');
  });

  it('workerId ausente no mapa de nomes → displayName null (`?? null`, nunca undefined)', () => {
    const result = buildServiceTeamResult({ serviceId: 's-1', liveVacancyId: null, candidacies: [] }, teamDerivado(), new Map());
    expect(result.selected[0].displayName).toBeNull();
    expect(result.inService[0].displayName).toBeNull();
    expect(result.rejected[0].displayName).toBeNull();
    expect(result.vacancyId).toBeNull();
    expect(result.rejected[0].vacancyId).toBeNull();
  });

  it('D445 (rodada 2): occupation de `row.candidacies` entra em `selected`, SEM KMS (coluna plana, sem célula)', () => {
    const displayNameByWorkerId = new Map<string, string | null>([['w-selected', 'Selected']]);
    const row = {
      serviceId: 's-1',
      liveVacancyId: 'v-live',
      candidacies: [{ workerId: 'w-selected', vacancyId: 'v-live', stage: 'QUICK_RESPONSE_TEAM', firstNameEncrypted: null, lastNameEncrypted: null, occupation: 'CAREGIVER' }],
    };
    const result = buildServiceTeamResult(row, teamDerivado(), displayNameByWorkerId);
    expect(result.selected[0].occupation).toBe('CAREGIVER');
  });

  it('D445 (rodada 2): worker sem occupation cadastrada → `occupation: null`, nunca `undefined` na chave', () => {
    const row = {
      serviceId: 's-1',
      liveVacancyId: 'v-live',
      candidacies: [{ workerId: 'w-selected', vacancyId: 'v-live', stage: 'QUICK_RESPONSE_TEAM', firstNameEncrypted: null, lastNameEncrypted: null, occupation: null }],
    };
    const result = buildServiceTeamResult(row, teamDerivado(), new Map());
    expect(result.selected[0].occupation).toBeNull();
    expect('occupation' in result.selected[0]).toBe(true);
  });

  it('D445 (rodada 2): candidacies vazio (dublê antigo) → `selected` sai SEM a chave occupation', () => {
    const result = buildServiceTeamResult({ serviceId: 's-1', liveVacancyId: 'v-live', candidacies: [] }, teamDerivado(), new Map());
    expect('occupation' in result.selected[0]).toBe(false);
  });
});

/**
 * deriveServiceTeamFromRows — P8, DX-11.6: a fonte única do mapeamento `row → deriveServiceTeam`,
 * que `GetServiceTeamUseCase`/`ServiceTeamMarkUseCase` duplicavam. `asOf` vem de `operationDateOf`
 * (data LOCAL do país do paciente, nunca o relógio do processo) — o mesmo caso do P8 da Fase 10:
 * `now = 2026-09-28T02:30:00Z` em AR (UTC-3) é ainda 27/09 local, então uma alocação que só começa
 * em 28/09 NÃO conta como vigente.
 */
describe('deriveServiceTeamFromRows', () => {
  const NOW = new Date('2026-09-28T02:30:00Z');
  const ASOF_AR = '2026-09-27'; // NOW em America/Argentina/Buenos_Aires (UTC-3)

  function rowComAlocacaoFutura(): ServiceTeamRows {
    return {
      serviceId: 's-1',
      country: 'AR',
      liveVacancyId: 'v-live',
      candidacies: [
        { workerId: 'w1', vacancyId: 'v-live', stage: SERVICE_TEAM_ENTRY_STAGE, firstNameEncrypted: null, lastNameEncrypted: null },
      ],
      assignments: [
        { workerId: 'w1', serviceId: 's-1', vacancyId: 'v-live', validFrom: '2026-09-28', validTo: null, status: 'ACTIVE', firstNameEncrypted: null, lastNameEncrypted: null },
      ],
      marks: [],
    };
  }

  it('asOf é a data LOCAL do país (AR) — alocação que só começa "hoje" em UTC ainda não é vigente, worker segue em selected', () => {
    const row = rowComAlocacaoFutura();
    const result = deriveServiceTeamFromRows(row, NOW);

    expect(result.inService).toEqual([]);
    expect(result.selected).toEqual([{ workerId: 'w1', vacancyId: 'v-live' }]);
    expect(result.asOf).toBe(ASOF_AR);
  });

  it('as 3 listas batem exatamente com deriveServiceTeam chamada à mão, com o MESMO asOf (DX-13.4: asOf agora vai anexado ao resultado)', () => {
    const row = rowComAlocacaoFutura();
    const esperado = deriveServiceTeam({
      serviceId: row.serviceId,
      liveVacancyId: row.liveVacancyId,
      asOf: ASOF_AR,
      candidacies: row.candidacies,
      assignments: row.assignments,
      marks: row.marks,
      substitutions: row.substitutions ?? [],
    });

    expect(deriveServiceTeamFromRows(row, NOW)).toEqual({ ...esperado, asOf: ASOF_AR });
  });
});
