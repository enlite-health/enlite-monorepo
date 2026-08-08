import {
  FindPatientChatCandidatesUseCase,
  DEFAULT_CANDIDATE_LIMIT,
} from '../FindPatientChatCandidatesUseCase';
import { PatientChatIdsNotFoundError } from '../PatientChatIdsService';
import type { PatientChatIdsRepository } from '../../infrastructure/PatientChatIdsRepository';
import type { PeriskopeChatReadService } from '@modules/notification';

jest.mock('../../infrastructure/PatientChatIdsRepository', () => ({
  PatientChatIdsRepository: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('@modules/notification', () => ({
  PeriskopeChatReadService: jest.fn().mockImplementation(() => ({})),
}));

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

function periskopeMock(groups: unknown) {
  return { listGroupChats: jest.fn().mockResolvedValue(groups) } as unknown as PeriskopeChatReadService;
}

const GROUPS = [
  { chatId: '120363001111111111@g.us', chatName: 'Flia Maria Perez', memberCount: 5 },
  { chatId: '120363002222222222@g.us', chatName: 'Prestadores Maria Perez', memberCount: 9 },
  { chatId: '120363003333333333@g.us', chatName: 'Flia Gomez', memberCount: 4 },
];

describe('FindPatientChatCandidatesUseCase', () => {
  it('devolve os candidatos ranqueados e o total de grupos varridos', async () => {
    const uc = new FindPatientChatCandidatesUseCase(repoMock(), periskopeMock(GROUPS));
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
    const out = await new FindPatientChatCandidatesUseCase(repo, periskopeMock(GROUPS)).execute(PATIENT);

    if (!out.ok) throw new Error('esperava ok');
    expect(out.candidates.find(c => c.chatId === '120363002222222222@g.us')?.linkedToOtherPatient).toBe(true);
  });

  it('respeita o limite pedido', async () => {
    const out = await new FindPatientChatCandidatesUseCase(repoMock(), periskopeMock(GROUPS)).execute(PATIENT, 1);
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
      new FindPatientChatCandidatesUseCase(repo, periskope).execute(PATIENT),
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

    const out = await new FindPatientChatCandidatesUseCase(repo, periskope).execute(PATIENT);
    expect(out).toEqual({ ok: false, reason: 'patient_has_no_name' });
    expect(periskope.listGroupChats).not.toHaveBeenCalled();
  });

  it('paciente só com sobrenome ainda busca', async () => {
    const repo = repoMock({
      findById: jest.fn().mockResolvedValue({
        id: PATIENT, firstName: null, lastName: 'Perez', familyChatId: null, providersChatId: null,
      }),
    });
    const out = await new FindPatientChatCandidatesUseCase(repo, periskopeMock(GROUPS)).execute(PATIENT);
    expect(out.ok).toBe(true);
  });

  it('Periskope indisponível → periskope_unavailable (não confunde com "não achei")', async () => {
    const out = await new FindPatientChatCandidatesUseCase(repoMock(), periskopeMock(null)).execute(PATIENT);
    expect(out).toEqual({ ok: false, reason: 'periskope_unavailable' });
  });

  it('Periskope sem nenhum grupo → ok com lista vazia', async () => {
    const out = await new FindPatientChatCandidatesUseCase(repoMock(), periskopeMock([])).execute(PATIENT);
    expect(out).toEqual({ ok: true, candidates: [], totalGroups: 0 });
  });

  it('nenhum grupo parecido → ok com lista vazia (não devolve os 774 por desencargo)', async () => {
    const irrelevantes = [{ chatId: '120363009999999999@g.us', chatName: 'Flia Gomez', memberCount: 3 }];
    const out = await new FindPatientChatCandidatesUseCase(repoMock(), periskopeMock(irrelevantes)).execute(PATIENT);
    if (!out.ok) throw new Error('esperava ok');
    expect(out.candidates).toEqual([]);
    expect(out.totalGroups).toBe(1);
  });

  it('sem dependências injetadas, instancia os padrões', () => {
    expect(() => new FindPatientChatCandidatesUseCase()).not.toThrow();
  });
});
