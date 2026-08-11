import {
  FindPatientChatCandidatesUseCase,
  DEFAULT_CANDIDATE_LIMIT,
} from '../FindPatientChatCandidatesUseCase';
import { PatientChatIdsNotFoundError } from '../PatientChatIdsService';
import type { PatientChatIdsRepository } from '../../infrastructure/PatientChatIdsRepository';
import type { PatientChatRolesRepository } from '../../infrastructure/PatientChatRolesRepository';
import type { PatientChatRoleSpec } from '../../domain/PatientChatRole';
import type { PeriskopeChatReadService } from '@modules/notification';

jest.mock('../../infrastructure/PatientChatIdsRepository', () => ({
  PatientChatIdsRepository: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../infrastructure/PatientChatRolesRepository', () => ({
  PatientChatRolesRepository: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('@modules/notification', () => ({
  PeriskopeChatReadService: jest.fn().mockImplementation(() => ({})),
}));

function roleSpec(code: string, matchKeywords: string[]): PatientChatRoleSpec {
  return {
    code,
    labelEs: code,
    labelPtBr: code,
    isExclusive: true,
    displayOrder: 0,
    isActive: true,
    matchKeywords,
  };
}

/** O catálogo semeado pela 262, no recorte que o desempate usa. */
const ROLES = [
  roleSpec('FAMILY', ['flia', 'familia']),
  roleSpec('PROVIDERS', ['equipo', 'prestadores']),
];

function rolesRepoMock(roles: PatientChatRoleSpec[] = ROLES) {
  return {
    listActive: jest.fn().mockResolvedValue(roles),
  } as unknown as PatientChatRolesRepository;
}

const PATIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';

function repoMock(over: Record<string, unknown> = {}) {
  return {
    findById: jest.fn().mockResolvedValue({
      id: PATIENT, firstName: 'Maria', lastName: 'Perez',
      familyChatId: null, providersChatId: null,
    }),
    findLinkedElsewhere: jest.fn().mockResolvedValue([]),
    ...over,
  } as unknown as PatientChatIdsRepository;
}

/**
 * `groups === null` = não deu para consultar o Periskope. Caso contrário devolve
 * o envelope novo do serviço: a lista MAIS o sinal de lista incompleta, que o
 * use case precisa repassar até a tela.
 */
function periskopeMock(groups: unknown, truncated = false) {
  const result = groups === null ? null : { groups, truncated };
  return {
    listGroupChats: jest.fn().mockResolvedValue(result),
  } as unknown as PeriskopeChatReadService;
}

const GROUPS = [
  { chatId: '120363001111111111@g.us', chatName: 'Flia Maria Perez', memberCount: 5 },
  { chatId: '120363002222222222@g.us', chatName: 'Prestadores Maria Perez', memberCount: 9 },
  { chatId: '120363003333333333@g.us', chatName: 'Flia Gomez', memberCount: 4 },
];

describe('FindPatientChatCandidatesUseCase', () => {
  it('devolve os candidatos ranqueados e o total de grupos varridos', async () => {
    const uc = new FindPatientChatCandidatesUseCase(repoMock(), periskopeMock(GROUPS), rolesRepoMock());
    const out = await uc.execute(PATIENT);

    expect(out).toMatchObject({ ok: true, totalGroups: 3 });
    if (!out.ok) throw new Error('esperava ok');
    expect(out.candidates.map(c => c.chatId)).toEqual([
      '120363001111111111@g.us',
      '120363002222222222@g.us',
    ]);
  });

  it('marca candidato já preso a outro paciente', async () => {
    const repo = repoMock({
      findLinkedElsewhere: jest.fn().mockResolvedValue([
        { chatId: '120363002222222222@g.us', patientId: OTHER, role: 'providers' },
      ]),
    });
    const out = await new FindPatientChatCandidatesUseCase(repo, periskopeMock(GROUPS), rolesRepoMock()).execute(PATIENT);

    if (!out.ok) throw new Error('esperava ok');
    expect(out.candidates.find(c => c.chatId === '120363002222222222@g.us')?.linkedToOtherPatient).toBe(true);
  });

  it('respeita o limite pedido', async () => {
    const out = await new FindPatientChatCandidatesUseCase(repoMock(), periskopeMock(GROUPS), rolesRepoMock()).execute(PATIENT, 1);
    if (!out.ok) throw new Error('esperava ok');
    expect(out.candidates).toHaveLength(1);
  });

  it('limite default é 10', () => {
    expect(DEFAULT_CANDIDATE_LIMIT).toBe(10);
  });

  it('paciente inexistente lança PatientChatIdsNotFoundError antes de tocar no Periskope', async () => {
    const periskope = periskopeMock(GROUPS);
    const repo = repoMock({ findById: jest.fn().mockResolvedValue(null) });

    await expect(
      new FindPatientChatCandidatesUseCase(repo, periskope, rolesRepoMock()).execute(PATIENT),
    ).rejects.toBeInstanceOf(PatientChatIdsNotFoundError);
    expect(periskope.listGroupChats).not.toHaveBeenCalled();
  });

  it('paciente sem nome nenhum → patient_has_no_name, sem consultar o Periskope', async () => {
    const periskope = periskopeMock(GROUPS);
    const repo = repoMock({
      findById: jest.fn().mockResolvedValue({
        id: PATIENT, firstName: null, lastName: null, familyChatId: null, providersChatId: null,
      }),
    });

    const out = await new FindPatientChatCandidatesUseCase(repo, periskope, rolesRepoMock()).execute(PATIENT);
    expect(out).toEqual({ ok: false, reason: 'patient_has_no_name' });
    expect(periskope.listGroupChats).not.toHaveBeenCalled();
  });

  it('paciente só com sobrenome ainda busca', async () => {
    const repo = repoMock({
      findById: jest.fn().mockResolvedValue({
        id: PATIENT, firstName: null, lastName: 'Perez', familyChatId: null, providersChatId: null,
      }),
    });
    const out = await new FindPatientChatCandidatesUseCase(repo, periskopeMock(GROUPS), rolesRepoMock()).execute(PATIENT);
    expect(out.ok).toBe(true);
  });

  it('Periskope indisponível → periskope_unavailable (não confunde com "não achei")', async () => {
    const out = await new FindPatientChatCandidatesUseCase(repoMock(), periskopeMock(null), rolesRepoMock()).execute(PATIENT);
    expect(out).toEqual({ ok: false, reason: 'periskope_unavailable' });
  });

  it('Periskope sem nenhum grupo → ok com lista vazia', async () => {
    const out = await new FindPatientChatCandidatesUseCase(repoMock(), periskopeMock([]), rolesRepoMock()).execute(PATIENT);
    expect(out).toEqual({
      ok: true,
      candidates: [],
      candidatesByRole: { FAMILY: [], PROVIDERS: [] },
      totalGroups: 0,
      groupListTruncated: false,
    });
  });

  it('lista incompleta VIAJA até a saída — "não achei" nunca se confunde com "cortei"', async () => {
    // Sem este repasse, o operador lê "nenhum candidato" quando a verdade é que
    // a varredura parou antes de chegar no grupo dele. É o defeito que o teto
    // silencioso de 1.000 grupos criava.
    const out = await new FindPatientChatCandidatesUseCase(
      repoMock(),
      periskopeMock([], true),
      rolesRepoMock(),
    ).execute(PATIENT);

    expect(out).toEqual({
      ok: true,
      candidates: [],
      candidatesByRole: { FAMILY: [], PROVIDERS: [] },
      totalGroups: 0,
      groupListTruncated: true,
    });
  });

  // ── desempate por papel (§6 do handoff) ───────────────────────────────────

  it('cada papel recebe a MESMA lista em ordem própria — o empate deixa de ser alfabético', async () => {
    // O caso real medido: "Flia Maria Perez" e "Prestadores Maria Perez" têm o
    // MESMO score (mesmos termos do paciente), e o desempate antigo era
    // localeCompare do nome do grupo — que punha "Prestadores"/"Equipo" antes
    // de "Flia" sempre. Era alfabeto decidindo papel.
    const out = await new FindPatientChatCandidatesUseCase(
      repoMock(),
      periskopeMock(GROUPS),
      rolesRepoMock(),
    ).execute(PATIENT);
    if (!out.ok) throw new Error('esperava ok');

    expect(out.candidatesByRole.FAMILY[0]).toBe('120363001111111111@g.us');
    expect(out.candidatesByRole.PROVIDERS[0]).toBe('120363002222222222@g.us');
  });

  it('a lista GLOBAL não muda: o desempate não mexe no que a tela exibe como ranking', async () => {
    const out = await new FindPatientChatCandidatesUseCase(
      repoMock(),
      periskopeMock(GROUPS),
      rolesRepoMock(),
    ).execute(PATIENT);
    if (!out.ok) throw new Error('esperava ok');

    // mesma quantidade e mesmo conjunto em toda ordem por papel
    for (const ordered of Object.values(out.candidatesByRole)) {
      expect([...ordered].sort()).toEqual(out.candidates.map(c => c.chatId).sort());
    }
  });

  it('papel DESATIVADO não aparece em candidatesByRole', async () => {
    const out = await new FindPatientChatCandidatesUseCase(
      repoMock(),
      periskopeMock(GROUPS),
      rolesRepoMock([roleSpec('FAMILY', ['flia'])]),
    ).execute(PATIENT);
    if (!out.ok) throw new Error('esperava ok');

    expect(Object.keys(out.candidatesByRole)).toEqual(['FAMILY']);
  });

  it('nenhum grupo parecido → ok com lista vazia (não devolve os 774 por desencargo)', async () => {
    const irrelevantes = [{ chatId: '120363009999999999@g.us', chatName: 'Flia Gomez', memberCount: 3 }];
    const out = await new FindPatientChatCandidatesUseCase(repoMock(), periskopeMock(irrelevantes), rolesRepoMock()).execute(PATIENT);
    if (!out.ok) throw new Error('esperava ok');
    expect(out.candidates).toEqual([]);
    expect(out.totalGroups).toBe(1);
  });

  it('sem dependências injetadas, instancia os padrões', () => {
    expect(() => new FindPatientChatCandidatesUseCase()).not.toThrow();
  });
});
