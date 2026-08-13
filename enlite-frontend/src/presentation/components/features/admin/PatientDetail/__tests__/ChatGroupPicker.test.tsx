/**
 * Unit do seletor de grupo POR BUSCA — o caminho do papel COMPARTILHADO.
 *
 * Testado através do card (e não isolado) de propósito: o que precisa de prova
 * não é o componente sozinho, é a REGRA DE ESCOLHA — papel exclusivo recebe o
 * seletor ranqueado, compartilhado recebe a busca. Um teste do componente
 * isolado passaria mesmo se o drawer nunca o renderizasse.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import { patientDetailFixture, patientDetailMinimal } from './patientDetailFixture';
import type { PatientChatRoleSpec } from '@domain/value-objects/patientChatRole';

const translations = ptBR as Record<string, any>;
function t(key: string, opts?: any): string {
  const parts = key.split('.');
  let cur: any = translations;
  for (const p of parts) cur = cur?.[p];
  if (typeof cur !== 'string') return typeof opts === 'string' ? opts : key;
  return cur.replace(/\{\{(\w+)\}\}/g, (_m, k) => String(opts?.[k] ?? ''));
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t, i18n: { language: 'pt-BR' } }) }));

const getPatientChatCandidates = vi.fn();
const updatePatientChatIds = vi.fn();
const listPatientChatRoles = vi.fn();
const listChatGroups = vi.fn();
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    getPatientChatCandidates: (...a: unknown[]) => getPatientChatCandidates(...a),
    updatePatientChatIds: (...a: unknown[]) => updatePatientChatIds(...a),
    listPatientChatRoles: (...a: unknown[]) => listPatientChatRoles(...a),
    listChatGroups: (...a: unknown[]) => listChatGroups(...a),
  },
}));

const { PatientChatIdsCard } = await import('../PatientChatIdsCard');

function spec(code: string, isExclusive: boolean, order: number): PatientChatRoleSpec {
  return {
    code,
    labelEs: `es ${code}`,
    labelPtBr: `pt ${code}`,
    isExclusive,
    displayOrder: order,
    isActive: true,
    matchKeywords: [],
  };
}
/** O catálogo semeado: os dois primeiros exclusivos, o terceiro compartilhado. */
const CATALOG = [
  spec('FAMILY', true, 1),
  spec('PROVIDERS', true, 2),
  spec('HEALTH_PLAN', false, 3),
];

const GESTION_DAS = '120363099000000001@g.us';
const GESTION_OSPJN = '120363099000000002@g.us';

const GROUPS = [
  { chatId: GESTION_DAS, chatName: 'Gestión: EnLite <> DAS', memberCount: 16, orgPhone: '549117@c.us', linkedPatientCount: 40 },
  { chatId: GESTION_OSPJN, chatName: 'Gestión: EnLite <> OSPJN', memberCount: 16, orgPhone: '549117@c.us', linkedPatientCount: 0 },
];

function groupsResult(over: Record<string, unknown> = {}) {
  return { groups: GROUPS, total: GROUPS.length, limit: 20, offset: 0, hasMore: false, listTruncated: false, ...over };
}

async function openDrawer(patient = patientDetailMinimal) {
  render(<PatientChatIdsCard patient={patient} />);
  await screen.findByTestId('chat-id-FAMILY-value');
  fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));
}

describe('ChatGroupPicker — papel compartilhado', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    getPatientChatCandidates.mockResolvedValue({ candidates: [], totalGroups: 0 });
    updatePatientChatIds.mockResolvedValue({ id: 'x', chatIds: {} });
    listPatientChatRoles.mockResolvedValue({ roles: CATALOG });
    listChatGroups.mockResolvedValue(groupsResult());
  });

  it('papel EXCLUSIVO usa o seletor ranqueado; COMPARTILHADO usa a busca', async () => {
    // É a regra inteira desta mudança: a ferramenta segue a natureza do papel,
    // e o dado que decide (`isExclusive`) já vem do catálogo.
    await openDrawer();

    expect(screen.getByTestId('chat-ids-FAMILY-select')).toBeInTheDocument();
    expect(screen.getByTestId('chat-ids-PROVIDERS-select')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-ids-HEALTH_PLAN-select')).toBeNull();

    expect(screen.getByTestId('chat-ids-HEALTH_PLAN-picker')).toBeInTheDocument();
  });

  it('acha o grupo da obra social — que o ranqueamento NUNCA traria', async () => {
    // `Gestión: EnLite <> DAS` tem semelhança zero com o nome do paciente, então
    // o `/chat-candidates` o descarta (score 0). É o buraco que esta busca fecha.
    await openDrawer();

    await waitFor(() => expect(listChatGroups).toHaveBeenCalled());
    expect(await screen.findByTestId(`chat-ids-HEALTH_PLAN-option-${GESTION_DAS}`)).toHaveTextContent(
      'Gestión: EnLite <> DAS',
    );
  });

  it('a contagem de pacientes aparece como INFORMAÇÃO, não como aviso', async () => {
    // Num papel compartilhado, "40 pacientes" é o esperado. Marcar isso como
    // problema treinaria quem opera a ignorar o alerta onde ele importa.
    await openDrawer();

    const opt = await screen.findByTestId(`chat-ids-HEALTH_PLAN-option-${GESTION_DAS}`);
    expect(opt).toHaveTextContent('40 paciente(s) usam este grupo');
    expect(opt).not.toHaveTextContent(ptBR.admin.patients.detail.chatIdsCard.alreadyLinked);
  });

  it('escolher grava o chat_id no salvar', async () => {
    await openDrawer();
    fireEvent.click(await screen.findByTestId(`chat-ids-HEALTH_PLAN-option-${GESTION_DAS}`));

    expect(screen.getByTestId('chat-ids-HEALTH_PLAN-chosen')).toHaveTextContent(GESTION_DAS);

    fireEvent.click(screen.getByTestId('chat-ids-save'));
    await waitFor(() => expect(updatePatientChatIds).toHaveBeenCalledWith(patientDetailMinimal.id, {
      chatIds: { FAMILY: null, PROVIDERS: null, HEALTH_PLAN: GESTION_DAS },
    }));
  });

  it('remover o escolhido desvincula (null no salvar)', async () => {
    await openDrawer();
    fireEvent.click(await screen.findByTestId(`chat-ids-HEALTH_PLAN-option-${GESTION_DAS}`));
    fireEvent.click(screen.getByTestId('chat-ids-HEALTH_PLAN-clear'));

    expect(screen.queryByTestId('chat-ids-HEALTH_PLAN-chosen')).toBeNull();

    fireEvent.click(screen.getByTestId('chat-ids-save'));
    await waitFor(() => expect(updatePatientChatIds).toHaveBeenCalledWith(patientDetailMinimal.id, {
      chatIds: { FAMILY: null, PROVIDERS: null, HEALTH_PLAN: null },
    }));
  });

  it('busca por texto consulta o backend com o termo', async () => {
    await openDrawer();
    await waitFor(() => expect(listChatGroups).toHaveBeenCalled());

    fireEvent.change(screen.getByTestId('chat-ids-HEALTH_PLAN-search'), { target: { value: 'gestion' } });

    await waitFor(() =>
      expect(listChatGroups).toHaveBeenCalledWith(expect.objectContaining({ search: 'gestion' })),
    );
  });

  it('NÃO consulta a cada tecla — o debounce protege o Periskope', async () => {
    await openDrawer();
    await waitFor(() => expect(listChatGroups).toHaveBeenCalledTimes(1));

    const input = screen.getByTestId('chat-ids-HEALTH_PLAN-search');
    for (const v of ['g', 'ge', 'ges', 'gest']) {
      fireEvent.change(input, { target: { value: v } });
    }
    await waitFor(() =>
      expect(listChatGroups).toHaveBeenCalledWith(expect.objectContaining({ search: 'gest' })),
    );
    // 1 da montagem + 1 do termo final — não 5
    expect(listChatGroups.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('grupo já usado em OUTRO papel do mesmo paciente some da lista', async () => {
    // O banco recusa o mesmo grupo em dois papéis do MESMO paciente (UNIQUE
    // patient_chat_ids_one_role_per_chat). Oferecê-lo seria oferecer um 400.
    // O paciente já tem o grupo gravado como FAMILY.
    const comFamily = { ...patientDetailMinimal, chatIds: { FAMILY: GESTION_DAS } };
    await openDrawer(comFamily);

    // o outro grupo aparece…
    expect(await screen.findByTestId(`chat-ids-HEALTH_PLAN-option-${GESTION_OSPJN}`)).toBeInTheDocument();
    // …e o que já é FAMILY deste paciente, não
    expect(screen.queryByTestId(`chat-ids-HEALTH_PLAN-option-${GESTION_DAS}`)).toBeNull();
  });

  it('vazio explica que só vemos grupos onde o NOSSO número está', async () => {
    // A causa real do "não achei" quase nunca é "não existe" — é membresia de
    // WhatsApp. Dizer isso poupa a pessoa de procurar o que nunca esteve ao
    // nosso alcance.
    listChatGroups.mockResolvedValue(groupsResult({ groups: [], total: 0 }));
    await openDrawer();

    const vazio = await screen.findByTestId('chat-ids-HEALTH_PLAN-empty');
    expect(vazio).toHaveTextContent('só enxergamos os grupos em que algum número nosso está dentro');
  });

  it('lista incompleta avisa, com role=alert', async () => {
    listChatGroups.mockResolvedValue(groupsResult({ listTruncated: true }));
    await openDrawer();

    const aviso = await screen.findByTestId('chat-ids-HEALTH_PLAN-truncated');
    expect(aviso).toHaveAttribute('role', 'alert');
  });

  it('erro do backend (ex.: 503 do kill-switch) aparece na tela', async () => {
    listChatGroups.mockRejectedValue(new Error('Chat lookup disabled'));
    await openDrawer();

    expect(await screen.findByTestId('chat-ids-HEALTH_PLAN-error')).toHaveTextContent('Chat lookup disabled');
  });

  it('vínculo JÁ GRAVADO aparece mesmo antes de qualquer busca', async () => {
    // Sem isto a tela diria "nada escolhido" para quem tem vínculo — e salvar
    // mandaria null, apagando o que a pessoa nunca viu.
    const comPlano = { ...patientDetailFixture, chatIds: { HEALTH_PLAN: GESTION_DAS } };
    render(<PatientChatIdsCard patient={comPlano} />);
    await screen.findByTestId('chat-id-FAMILY-value');
    fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));

    expect(screen.getByTestId('chat-ids-HEALTH_PLAN-chosen')).toHaveTextContent(GESTION_DAS);
  });
});
