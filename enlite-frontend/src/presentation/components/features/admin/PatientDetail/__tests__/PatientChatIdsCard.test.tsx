/**
 * Unit da vinculação de chat IDs (card + drawer).
 *
 * Mesmo padrão dos outros cards de PatientDetail: i18n resolvido contra o
 * pt-BR.json de verdade (chave errada aparece como a própria chave e o teste
 * quebra), react-router e AdminApiService mockados.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import { patientDetailFixture, patientDetailMinimal } from './patientDetailFixture';
import type { PatientChatRoleSpec } from '@domain/value-objects/patientChatRole';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

/**
 * O CATÁLOGO vem da API, não de uma constante do painel — é a mudança da
 * migration 262. Aqui ele é o que a migration semeia.
 */
const CATALOG: PatientChatRoleSpec[] = [
  { code: 'FAMILY', labelEs: 'Grupo de la familia', labelPtBr: 'Grupo da família', isExclusive: true, displayOrder: 1, isActive: true, matchKeywords: ['flia'] },
  { code: 'PROVIDERS', labelEs: 'Grupo de los prestadores', labelPtBr: 'Grupo dos prestadores', isExclusive: true, displayOrder: 2, isActive: true, matchKeywords: ['equipo'] },
  { code: 'HEALTH_PLAN', labelEs: 'Grupo de la obra social', labelPtBr: 'Grupo do plano de saúde', isExclusive: false, displayOrder: 3, isActive: true, matchKeywords: ['obra'] },
];
const ROLE_CODES = CATALOG.map(r => r.code);

const translations = ptBR as Record<string, any>;

function t(key: string, optsOrDefault?: any): string {
  const parts = key.split('.');
  let current: any = translations;
  for (const part of parts) current = current?.[part];
  if (typeof current === 'string') return current;
  if (typeof optsOrDefault === 'string') return optsOrDefault;
  return key;
}

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t, i18n: { language: 'pt-BR' } }) }));

const getPatientChatCandidates = vi.fn();
const updatePatientChatIds = vi.fn();
const listPatientChatRoles = vi.fn();
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    getPatientChatCandidates: (...a: unknown[]) => getPatientChatCandidates(...a),
    updatePatientChatIds: (...a: unknown[]) => updatePatientChatIds(...a),
    listPatientChatRoles: (...a: unknown[]) => listPatientChatRoles(...a),
  },
}));

const { PatientChatIdsCard } = await import('../PatientChatIdsCard');

const FAMILY = '120363090000000001@g.us';
const PROVIDERS = '120363090000000002@g.us';

const CANDIDATES = [
  { chatId: FAMILY, chatName: 'Flia Perez', memberCount: 6, score: 1, matchedTerms: ['perez'], linkedToOtherPatient: false },
  { chatId: PROVIDERS, chatName: 'Prestadores Perez', memberCount: 11, score: 0.75, matchedTerms: ['perez'], linkedToOtherPatient: false },
];

describe('PatientChatIdsCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPatientChatCandidates.mockResolvedValue({ candidates: CANDIDATES, totalGroups: 774 });
    updatePatientChatIds.mockResolvedValue({ id: 'x', chatIds: { FAMILY, PROVIDERS } });
    listPatientChatRoles.mockResolvedValue({ roles: CATALOG });
  });

  // ⚠️ Todo teste espera `chat-id-FAMILY-value` depois de renderizar: o catálogo
  // chega por REDE (migration 262), então no primeiro render a lista de papéis
  // ainda está vazia e um assert imediato mediria a tela errada.

  it('mostra os chat IDs gravados, um por papel', async () => {
    render(<PatientChatIdsCard patient={patientDetailFixture} />);
    await screen.findByTestId('chat-id-FAMILY-value');

    expect(screen.getByTestId('chat-id-FAMILY-value')).toHaveTextContent(FAMILY);
    expect(screen.getByTestId('chat-id-PROVIDERS-value')).toHaveTextContent(PROVIDERS);
  });

  it('paciente sem vínculo mostra "Não vinculado" em TODOS os papéis', async () => {
    render(<PatientChatIdsCard patient={patientDetailMinimal} />);
    await screen.findByTestId('chat-id-FAMILY-value');

    const notLinked = ptBR.admin.patients.detail.chatIdsCard.notLinked;
    for (const role of ROLE_CODES) {
      expect(screen.getByTestId(`chat-id-${role}-value`)).toHaveTextContent(notLinked);
    }
  });

  it('o TERCEIRO papel (plano de saúde) aparece na tela — é o pedido do áudio', async () => {
    render(<PatientChatIdsCard patient={patientDetailMinimal} />);
    await screen.findByTestId('chat-id-FAMILY-value');

    const slot = screen.getByTestId('chat-id-HEALTH_PLAN-value');
    // O rótulo vem do CATÁLOGO (label pt-BR), não mais de uma chave de i18n.
    expect(slot).toHaveTextContent('Grupo do plano de saúde');
    expect(slot).toHaveTextContent(ptBR.admin.patients.detail.chatIdsCard.notLinked);
  });

  it('mostra o vínculo de um papel que o painel NÃO conhece, com o código cru', async () => {
    // Deploy fora de ordem: o backend já grava um papel novo. Esconder o vínculo
    // seria pior que mostrar o código — quem opera precisa ver que existe.
    const withUnknown = {
      ...patientDetailMinimal,
      chatIds: { MANAGEMENT: '120363090000000009@g.us' },
    };
    render(<PatientChatIdsCard patient={withUnknown} />);
    await screen.findByTestId('chat-id-FAMILY-value');

    const slot = screen.getByTestId('chat-id-MANAGEMENT-value');
    expect(slot).toHaveTextContent('MANAGEMENT');
    expect(slot).toHaveTextContent('120363090000000009@g.us');
  });

  it('salvar NÃO manda papel que a tela não mostra — só o que a pessoa viu', async () => {
    render(<PatientChatIdsCard patient={patientDetailMinimal} />);
    await screen.findByTestId('chat-id-FAMILY-value');
    fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));
    fireEvent.click(screen.getByTestId('chat-ids-save'));

    await waitFor(() => expect(updatePatientChatIds).toHaveBeenCalled());
    const [, payload] = updatePatientChatIds.mock.calls[0];
    expect(Object.keys(payload.chatIds).sort()).toEqual([...ROLE_CODES].sort());
  });

  it('o rótulo segue o IDIOMA e vem do catálogo, não do arquivo de traduções', async () => {
    // Papel criado na tela de administração não teria como ter chave de i18n —
    // por isso os dois rótulos viajam no próprio catálogo. A garantia de que
    // nenhum papel fica sem rótulo é do BANCO (CHECK labels_not_blank) e do
    // schema Zod, não de um arquivo de locale.
    render(<PatientChatIdsCard patient={patientDetailMinimal} />);
    await screen.findByTestId('chat-id-FAMILY-value');

    expect(screen.getByTestId('chat-id-FAMILY-value')).toHaveTextContent('Grupo da família');
    expect(screen.getByTestId('chat-id-PROVIDERS-value')).toHaveTextContent('Grupo dos prestadores');
    // e o rótulo em espanhol existe no mesmo registro, para o painel es-AR
    expect(CATALOG.every(r => r.labelEs.trim() !== '' && r.labelPtBr.trim() !== '')).toBe(true);
  });

  it('catálogo que NÃO carregou ainda mostra o vínculo gravado', async () => {
    // Rede caída não pode fazer um vínculo existente sumir da tela: quem abre a
    // ficha vincularia outro grupo por cima sem saber que já havia um.
    listPatientChatRoles.mockRejectedValue(new Error('offline'));
    render(<PatientChatIdsCard patient={patientDetailFixture} />);

    const slot = await screen.findByTestId('chat-id-FAMILY-value');
    expect(slot).toHaveTextContent(FAMILY);
    // sem catálogo, o rótulo cai no próprio código — nunca em campo sem nome
    expect(slot).toHaveTextContent('FAMILY');
  });

  it('as chaves de i18n existem (nada renderiza a chave crua)', async () => {
    render(<PatientChatIdsCard patient={patientDetailFixture} />);
    await screen.findByTestId('chat-id-FAMILY-value');
    expect(screen.queryByText(/admin\.patients\.detail\.chatIdsCard/)).toBeNull();
  });

  it('resposta SEM `chatIds` (revisão antiga da API) não quebra o card', async () => {
    // Expand/contract: durante a janela de deploy, uma revisão anterior do
    // backend pode responder sem o campo novo. A tela tem de dizer "não
    // vinculado", não estourar.
    const semCampo = { ...patientDetailMinimal, chatIds: undefined as never };
    render(<PatientChatIdsCard patient={semCampo} />);
    await screen.findByTestId('chat-id-FAMILY-value');

    const notLinked = ptBR.admin.patients.detail.chatIdsCard.notLinked;
    for (const role of ROLE_CODES) {
      expect(screen.getByTestId(`chat-id-${role}-value`)).toHaveTextContent(notLinked);
    }
  });

  it('papel que APARECE com o drawer aberto mostra o que está GRAVADO', async () => {
    // O paciente é recarregado no pai e ganha um papel que o drawer ainda não
    // tinha na tela. O seletor novo abre com o valor gravado — nunca em branco
    // e nunca em `undefined` (React reclamaria de input não-controlado).
    //
    // ⚠️ Abrir em branco seria pior que feio: salvar mandaria `null` naquele
    // papel e apagaria o vínculo que a pessoa nunca chegou a ver.
    const { rerender } = render(<PatientChatIdsCard patient={patientDetailMinimal} />);
    await screen.findByTestId('chat-id-FAMILY-value');
    fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));

    rerender(
      <PatientChatIdsCard
        patient={{ ...patientDetailMinimal, chatIds: { MANAGEMENT: '120363090000000009@g.us' } }}
      />,
    );
    await screen.findByTestId('chat-id-FAMILY-value');

    const novo = screen.getByTestId('chat-ids-MANAGEMENT-select') as HTMLSelectElement;
    expect(novo.value).toBe('120363090000000009@g.us');
  });

  it('o drawer só aparece depois do clique', async () => {
    render(<PatientChatIdsCard patient={patientDetailMinimal} />);
    await screen.findByTestId('chat-id-FAMILY-value');
    expect(screen.queryByTestId('chat-ids-drawer')).toBeNull();

    fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));
    expect(screen.getByTestId('chat-ids-drawer')).toBeInTheDocument();
  });

  it('não busca nada antes de clicar em "buscar chats"', async () => {
    render(<PatientChatIdsCard patient={patientDetailMinimal} />);
    await screen.findByTestId('chat-id-FAMILY-value');
    fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));

    expect(getPatientChatCandidates).not.toHaveBeenCalled();
    expect(screen.queryByTestId('chat-ids-candidates')).toBeNull();
  });

  it('buscar → lista candidatos com score, membros e total varrido', async () => {
    render(<PatientChatIdsCard patient={patientDetailMinimal} />);
    await screen.findByTestId('chat-id-FAMILY-value');
    fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));
    fireEvent.click(screen.getByTestId('chat-ids-search-btn'));

    await waitFor(() => expect(screen.getByTestId('chat-ids-candidates')).toBeInTheDocument());
    expect(getPatientChatCandidates).toHaveBeenCalledWith(patientDetailMinimal.id);
    expect(screen.getByTestId(`chat-candidate-${FAMILY}`)).toHaveTextContent('Flia Perez');
    expect(screen.getByTestId(`chat-candidate-${FAMILY}`)).toHaveTextContent('100%');
    expect(screen.getByTestId(`chat-candidate-${PROVIDERS}`)).toHaveTextContent('75%');
    expect(screen.getByTestId('chat-ids-candidates')).toHaveTextContent('(2/774)');
  });

  it('marca na lista o grupo já preso a outro paciente', async () => {
    getPatientChatCandidates.mockResolvedValue({
      candidates: [{ ...CANDIDATES[0], linkedToOtherPatient: true }],
      totalGroups: 774,
    });
    render(<PatientChatIdsCard patient={patientDetailMinimal} />);
    await screen.findByTestId('chat-id-FAMILY-value');
    fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));
    fireEvent.click(screen.getByTestId('chat-ids-search-btn'));

    await waitFor(() => expect(screen.getByTestId(`chat-candidate-${FAMILY}`))
      .toHaveTextContent(ptBR.admin.patients.detail.chatIdsCard.alreadyLinked));
  });

  it('busca sem resultado mostra o vazio explícito', async () => {
    getPatientChatCandidates.mockResolvedValue({ candidates: [], totalGroups: 774 });
    render(<PatientChatIdsCard patient={patientDetailMinimal} />);
    await screen.findByTestId('chat-id-FAMILY-value');
    fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));
    fireEvent.click(screen.getByTestId('chat-ids-search-btn'));

    await waitFor(() => expect(screen.getByTestId('chat-ids-empty')).toBeInTheDocument());
  });

  it('lista incompleta AVISA na tela — o operador não pode ler "não achei" e ser "cortei"', async () => {
    // Este é o conserto do teto silencioso: antes, a lista podia vir cortada e a
    // tela dizia só "nenhum candidato". Quem vincula precisa saber a diferença.
    getPatientChatCandidates.mockResolvedValue({
      candidates: [],
      totalGroups: 10000,
      groupListTruncated: true,
    });
    render(<PatientChatIdsCard patient={patientDetailMinimal} />);
    await screen.findByTestId('chat-id-FAMILY-value');
    fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));
    fireEvent.click(screen.getByTestId('chat-ids-search-btn'));

    const aviso = await screen.findByTestId('chat-ids-truncated-warning');
    expect(aviso).toHaveTextContent(
      ptBR.admin.patients.detail.chatIdsCard.listTruncated,
    );
    // O aviso é role=alert: chega a leitor de tela, não é só cor.
    expect(aviso).toHaveAttribute('role', 'alert');
    // E o vazio continua aparecendo — são duas informações diferentes.
    expect(screen.getByTestId('chat-ids-empty')).toBeInTheDocument();
  });

  it('lista completa NÃO mostra o aviso de truncamento', async () => {
    getPatientChatCandidates.mockResolvedValue({
      candidates: CANDIDATES,
      totalGroups: 774,
      groupListTruncated: false,
    });
    render(<PatientChatIdsCard patient={patientDetailMinimal} />);
    await screen.findByTestId('chat-id-FAMILY-value');
    fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));
    fireEvent.click(screen.getByTestId('chat-ids-search-btn'));

    await waitFor(() => expect(screen.getByTestId('chat-ids-candidates')).toBeInTheDocument());
    expect(screen.queryByTestId('chat-ids-truncated-warning')).not.toBeInTheDocument();
  });

  it('erro na busca (ex.: kill-switch 503) aparece na tela', async () => {
    getPatientChatCandidates.mockRejectedValue(new Error('Chat lookup disabled'));
    render(<PatientChatIdsCard patient={patientDetailMinimal} />);
    await screen.findByTestId('chat-id-FAMILY-value');
    fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));
    fireEvent.click(screen.getByTestId('chat-ids-search-btn'));

    await waitFor(() => expect(screen.getByTestId('chat-ids-error')).toHaveTextContent('Chat lookup disabled'));
  });

  it('escolher os papéis e salvar manda o mapa inteiro e avisa o pai', async () => {
    const onSaved = vi.fn();
    render(<PatientChatIdsCard patient={patientDetailMinimal} onSaved={onSaved} />);
    await screen.findByTestId('chat-id-FAMILY-value');
    fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));
    fireEvent.click(screen.getByTestId('chat-ids-search-btn'));
    await waitFor(() => expect(screen.getByTestId('chat-ids-candidates')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('chat-ids-FAMILY-select'), { target: { value: FAMILY } });
    fireEvent.change(screen.getByTestId('chat-ids-PROVIDERS-select'), { target: { value: PROVIDERS } });
    fireEvent.click(screen.getByTestId('chat-ids-save'));

    await waitFor(() => expect(updatePatientChatIds).toHaveBeenCalledWith(patientDetailMinimal.id, {
      chatIds: { FAMILY, PROVIDERS, HEALTH_PLAN: null },
    }));
    expect(onSaved).toHaveBeenCalled();
  });

  it('o grupo escolhido para um papel some das opções do outro', async () => {
    render(<PatientChatIdsCard patient={patientDetailMinimal} />);
    await screen.findByTestId('chat-id-FAMILY-value');
    fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));
    fireEvent.click(screen.getByTestId('chat-ids-search-btn'));
    await waitFor(() => expect(screen.getByTestId('chat-ids-candidates')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('chat-ids-FAMILY-select'), { target: { value: FAMILY } });

    const providersSelect = screen.getByTestId('chat-ids-PROVIDERS-select') as HTMLSelectElement;
    const values = Array.from(providersSelect.querySelectorAll('option')).map(o => o.value);
    expect(values).not.toContain(FAMILY);
    expect(values).toContain(PROVIDERS);
  });

  it('salvar vazio desvincula (null em todos os papéis)', async () => {
    updatePatientChatIds.mockResolvedValue({ id: 'x', chatIds: {} });
    render(<PatientChatIdsCard patient={patientDetailMinimal} />);
    await screen.findByTestId('chat-id-FAMILY-value');
    fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));
    fireEvent.click(screen.getByTestId('chat-ids-save'));

    await waitFor(() => expect(updatePatientChatIds).toHaveBeenCalledWith(patientDetailMinimal.id, {
      chatIds: { FAMILY: null, PROVIDERS: null, HEALTH_PLAN: null },
    }));
  });

  it('erro do backend no salvar (ex.: 409) aparece na tela e não fecha', async () => {
    updatePatientChatIds.mockRejectedValue(new Error('Chat id already linked to another patient'));
    render(<PatientChatIdsCard patient={patientDetailMinimal} />);
    await screen.findByTestId('chat-id-FAMILY-value');
    fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));
    fireEvent.click(screen.getByTestId('chat-ids-save'));

    await waitFor(() => expect(screen.getByTestId('chat-ids-error'))
      .toHaveTextContent('Chat id already linked to another patient'));
    expect(screen.getByTestId('chat-ids-drawer')).toBeInTheDocument();
  });

  it('drawer abre já com o que o paciente tem gravado, sem option duplicada', async () => {
    render(<PatientChatIdsCard patient={patientDetailFixture} />);
    await screen.findByTestId('chat-id-FAMILY-value');
    fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));

    const familySelect = screen.getByTestId('chat-ids-FAMILY-select') as HTMLSelectElement;
    expect(familySelect.value).toBe(FAMILY);
    expect((screen.getByTestId('chat-ids-PROVIDERS-select') as HTMLSelectElement).value).toBe(PROVIDERS);

    // Chave duplicada no <select> é warning do React e option fantasma na tela.
    const values = Array.from(familySelect.querySelectorAll('option')).map(o => o.value);
    expect(values.length).toBe(new Set(values).size);
  });

  it('a UI torna impossível escolher o mesmo grupo nos dois papéis', async () => {
    render(<PatientChatIdsCard patient={patientDetailMinimal} />);
    await screen.findByTestId('chat-id-FAMILY-value');
    fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));
    fireEvent.click(screen.getByTestId('chat-ids-search-btn'));
    await waitFor(() => expect(screen.getByTestId('chat-ids-candidates')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('chat-ids-PROVIDERS-select'), { target: { value: FAMILY } });
    // Tentar pôr o MESMO grupo em família não pega: a option foi removida.
    fireEvent.change(screen.getByTestId('chat-ids-FAMILY-select'), { target: { value: FAMILY } });

    expect((screen.getByTestId('chat-ids-FAMILY-select') as HTMLSelectElement).value).toBe('');
    fireEvent.click(screen.getByTestId('chat-ids-save'));
    await waitFor(() => expect(updatePatientChatIds).toHaveBeenCalledWith(patientDetailMinimal.id, {
      chatIds: { FAMILY: null, PROVIDERS: FAMILY, HEALTH_PLAN: null },
    }));
  });

  it('candidato sem nome e sem contagem de membros não quebra a lista', async () => {
    getPatientChatCandidates.mockResolvedValue({
      candidates: [{ chatId: FAMILY, chatName: null, memberCount: null, score: 0.5, matchedTerms: [], linkedToOtherPatient: false }],
      totalGroups: 1,
    });
    render(<PatientChatIdsCard patient={patientDetailMinimal} />);
    await screen.findByTestId('chat-id-FAMILY-value');
    fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));
    fireEvent.click(screen.getByTestId('chat-ids-search-btn'));

    await waitFor(() => expect(screen.getByTestId(`chat-candidate-${FAMILY}`)).toHaveTextContent(FAMILY));
    const options = Array.from(
      (screen.getByTestId('chat-ids-FAMILY-select') as HTMLSelectElement).querySelectorAll('option'),
    ).map(o => o.textContent);
    expect(options).toContain(FAMILY); // rótulo cai no próprio id
  });

  it('falha sem mensagem cai no texto traduzido de erro', async () => {
    getPatientChatCandidates.mockRejectedValue('sem message');
    render(<PatientChatIdsCard patient={patientDetailMinimal} />);
    await screen.findByTestId('chat-id-FAMILY-value');
    fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));
    fireEvent.click(screen.getByTestId('chat-ids-search-btn'));

    await waitFor(() => expect(screen.getByTestId('chat-ids-error'))
      .toHaveTextContent(ptBR.admin.patients.detail.chatIdsCard.searchError));

    updatePatientChatIds.mockRejectedValue('sem message');
    fireEvent.click(screen.getByTestId('chat-ids-save'));
    await waitFor(() => expect(screen.getByTestId('chat-ids-error'))
      .toHaveTextContent(ptBR.admin.patients.detail.chatIdsCard.saveError));
  });

  it('ESC fecha o drawer', async () => {
    render(<PatientChatIdsCard patient={patientDetailMinimal} />);
    await screen.findByTestId('chat-id-FAMILY-value');
    fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));

    fireEvent.keyDown(document, { key: 'Enter' });
    expect(screen.getByTestId('chat-ids-drawer')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('chat-ids-drawer')).toBeNull(), { timeout: 2000 });
  });

  it('o X do cabeçalho fecha o drawer', async () => {
    render(<PatientChatIdsCard patient={patientDetailMinimal} />);
    await screen.findByTestId('chat-id-FAMILY-value');
    fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));

    fireEvent.click(screen.getByLabelText(ptBR.admin.patients.detail.chatIdsCard.close));
    await waitFor(() => expect(screen.queryByTestId('chat-ids-drawer')).toBeNull(), { timeout: 2000 });
  });

  it('backdrop fecha o drawer', async () => {
    render(<PatientChatIdsCard patient={patientDetailMinimal} />);
    await screen.findByTestId('chat-id-FAMILY-value');
    fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));
    fireEvent.click(screen.getByTestId('chat-ids-backdrop'));

    await waitFor(() => expect(screen.queryByTestId('chat-ids-drawer')).toBeNull(), { timeout: 2000 });
  });

  it('candidatesByRole reordena as options DAQUELE papel (desempate por palavra do catálogo)', async () => {
    getPatientChatCandidates.mockResolvedValue({
      candidates: CANDIDATES,
      candidatesByRole: { FAMILY: [PROVIDERS, FAMILY] },
      totalGroups: 774,
    });
    render(<PatientChatIdsCard patient={patientDetailMinimal} />);
    await screen.findByTestId('chat-id-FAMILY-value');
    fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));
    fireEvent.click(screen.getByTestId('chat-ids-search-btn'));
    await waitFor(() => expect(screen.getByTestId('chat-ids-candidates')).toBeInTheDocument());

    const select = screen.getByTestId('chat-ids-FAMILY-select') as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value).filter(Boolean);
    expect(values.slice(0, 2)).toEqual([PROVIDERS, FAMILY]);
  });

  // ── Spec 014 US-D4 (lex D4 AUTORIZADO): drawer não perde trabalho ──────────────────────
  describe('confirmação ao fechar com mudanças (US-D4)', () => {
    it('SEM mudança → backdrop fecha direto, sem confirmação', async () => {
      render(<PatientChatIdsCard patient={patientDetailMinimal} />);
      await screen.findByTestId('chat-id-FAMILY-value');
      fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));
      fireEvent.click(screen.getByTestId('chat-ids-backdrop'));
      expect(screen.queryByTestId('discard-changes-confirm')).not.toBeInTheDocument();
    });

    it('COM mudança (escolher um chat) → backdrop abre confirmação; "Seguir editando" mantém a escolha', async () => {
      render(<PatientChatIdsCard patient={patientDetailMinimal} />);
      await screen.findByTestId('chat-id-FAMILY-value');
      fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));
      fireEvent.click(screen.getByTestId('chat-ids-search-btn'));
      await waitFor(() => expect(screen.getByTestId('chat-ids-candidates')).toBeInTheDocument());
      fireEvent.change(screen.getByTestId('chat-ids-FAMILY-select'), { target: { value: FAMILY } });

      fireEvent.click(screen.getByTestId('chat-ids-backdrop'));
      expect(screen.getByTestId('discard-changes-confirm')).toBeVisible();
      fireEvent.click(screen.getByTestId('discard-changes-keep-editing'));
      expect(screen.queryByTestId('discard-changes-confirm')).not.toBeInTheDocument();
      expect((screen.getByTestId('chat-ids-FAMILY-select') as HTMLSelectElement).value).toBe(FAMILY);
    });

    it('"Descartar cambios" fecha de verdade', async () => {
      render(<PatientChatIdsCard patient={patientDetailMinimal} />);
      await screen.findByTestId('chat-id-FAMILY-value');
      fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));
      fireEvent.click(screen.getByTestId('chat-ids-search-btn'));
      await waitFor(() => expect(screen.getByTestId('chat-ids-candidates')).toBeInTheDocument());
      fireEvent.change(screen.getByTestId('chat-ids-FAMILY-select'), { target: { value: FAMILY } });

      fireEvent.click(screen.getByTestId('chat-ids-backdrop'));
      fireEvent.click(screen.getByTestId('discard-changes-discard'));
      await waitFor(() => expect(screen.queryByTestId('chat-ids-drawer')).toBeNull(), { timeout: 2000 });
    });

    it('SALVAR nunca pergunta, mesmo com mudança pendente', async () => {
      render(<PatientChatIdsCard patient={patientDetailMinimal} />);
      await screen.findByTestId('chat-id-FAMILY-value');
      fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));
      fireEvent.click(screen.getByTestId('chat-ids-search-btn'));
      await waitFor(() => expect(screen.getByTestId('chat-ids-candidates')).toBeInTheDocument());
      fireEvent.change(screen.getByTestId('chat-ids-FAMILY-select'), { target: { value: FAMILY } });
      fireEvent.click(screen.getByTestId('chat-ids-save'));
      await waitFor(() => expect(updatePatientChatIds).toHaveBeenCalled());
      expect(screen.queryByTestId('discard-changes-confirm')).not.toBeInTheDocument();
    });
  });
});

// ── D269 — write-gate no botão "Vincular" (PUT /patients/:id/chat-ids → patient:write) ──

function comEnforcement(permissions: string[], enforcement: AuthzContract['enforcement']) {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: {
      uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement,
    } as AuthzContract,
  });
}

describe('PatientChatIdsCard — write-gate (D269)', () => {
  beforeEach(() => {
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
  });

  it('🔴 enforcement=on, sem patient:write: chat-ids-edit-btn SOME', async () => {
    comEnforcement([], 'on');
    render(<PatientChatIdsCard patient={patientDetailFixture} />);
    await screen.findByTestId('chat-id-FAMILY-value');
    expect(screen.queryByTestId('chat-ids-edit-btn')).not.toBeInTheDocument();
  });

  it('enforcement=on, com patient_chat:update (D286, PR-8b): chat-ids-edit-btn existe', async () => {
    comEnforcement(['patient_chat:update'], 'on');
    render(<PatientChatIdsCard patient={patientDetailFixture} />);
    await screen.findByTestId('chat-id-FAMILY-value');
    expect(screen.getByTestId('chat-ids-edit-btn')).toBeInTheDocument();
  });

  it('enforcement OFF (ou ausente): chat-ids-edit-btn existe mesmo sem célula', async () => {
    render(<PatientChatIdsCard patient={patientDetailFixture} />);
    await screen.findByTestId('chat-id-FAMILY-value');
    expect(screen.getByTestId('chat-ids-edit-btn')).toBeInTheDocument();
  });
});
