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

const translations = ptBR as Record<string, any>;

function t(key: string, optsOrDefault?: any): string {
  const parts = key.split('.');
  let current: any = translations;
  for (const part of parts) current = current?.[part];
  if (typeof current === 'string') return current;
  if (typeof optsOrDefault === 'string') return optsOrDefault;
  return key;
}

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));

const getPatientChatCandidates = vi.fn();
const updatePatientChatIds = vi.fn();
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    getPatientChatCandidates: (...a: unknown[]) => getPatientChatCandidates(...a),
    updatePatientChatIds: (...a: unknown[]) => updatePatientChatIds(...a),
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
    updatePatientChatIds.mockResolvedValue({ id: 'x', familyChatId: FAMILY, providersChatId: PROVIDERS });
  });

  it('mostra os dois chat IDs gravados', () => {
    render(<PatientChatIdsCard patient={patientDetailFixture} />);

    expect(screen.getByTestId('chat-id-family-value')).toHaveTextContent(FAMILY);
    expect(screen.getByTestId('chat-id-providers-value')).toHaveTextContent(PROVIDERS);
  });

  it('paciente sem vínculo mostra "Não vinculado" nos dois', () => {
    render(<PatientChatIdsCard patient={patientDetailMinimal} />);

    const notLinked = ptBR.admin.patients.detail.chatIdsCard.notLinked;
    expect(screen.getByTestId('chat-id-family-value')).toHaveTextContent(notLinked);
    expect(screen.getByTestId('chat-id-providers-value')).toHaveTextContent(notLinked);
  });

  it('as chaves de i18n existem (nada renderiza a chave crua)', () => {
    render(<PatientChatIdsCard patient={patientDetailFixture} />);
    expect(screen.queryByText(/admin\.patients\.detail\.chatIdsCard/)).toBeNull();
  });

  it('o drawer só aparece depois do clique', () => {
    render(<PatientChatIdsCard patient={patientDetailMinimal} />);
    expect(screen.queryByTestId('chat-ids-drawer')).toBeNull();

    fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));
    expect(screen.getByTestId('chat-ids-drawer')).toBeInTheDocument();
  });

  it('não busca nada antes de clicar em "buscar chats"', () => {
    render(<PatientChatIdsCard patient={patientDetailMinimal} />);
    fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));

    expect(getPatientChatCandidates).not.toHaveBeenCalled();
    expect(screen.queryByTestId('chat-ids-candidates')).toBeNull();
  });

  it('buscar → lista candidatos com score, membros e total varrido', async () => {
    render(<PatientChatIdsCard patient={patientDetailMinimal} />);
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
    fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));
    fireEvent.click(screen.getByTestId('chat-ids-search-btn'));

    await waitFor(() => expect(screen.getByTestId(`chat-candidate-${FAMILY}`))
      .toHaveTextContent(ptBR.admin.patients.detail.chatIdsCard.alreadyLinked));
  });

  it('busca sem resultado mostra o vazio explícito', async () => {
    getPatientChatCandidates.mockResolvedValue({ candidates: [], totalGroups: 774 });
    render(<PatientChatIdsCard patient={patientDetailMinimal} />);
    fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));
    fireEvent.click(screen.getByTestId('chat-ids-search-btn'));

    await waitFor(() => expect(screen.getByTestId('chat-ids-empty')).toBeInTheDocument());
  });

  it('erro na busca (ex.: kill-switch 503) aparece na tela', async () => {
    getPatientChatCandidates.mockRejectedValue(new Error('Chat lookup disabled'));
    render(<PatientChatIdsCard patient={patientDetailMinimal} />);
    fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));
    fireEvent.click(screen.getByTestId('chat-ids-search-btn'));

    await waitFor(() => expect(screen.getByTestId('chat-ids-error')).toHaveTextContent('Chat lookup disabled'));
  });

  it('escolher os dois papéis e salvar manda o par e avisa o pai', async () => {
    const onSaved = vi.fn();
    render(<PatientChatIdsCard patient={patientDetailMinimal} onSaved={onSaved} />);
    fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));
    fireEvent.click(screen.getByTestId('chat-ids-search-btn'));
    await waitFor(() => expect(screen.getByTestId('chat-ids-candidates')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('chat-ids-family-select'), { target: { value: FAMILY } });
    fireEvent.change(screen.getByTestId('chat-ids-providers-select'), { target: { value: PROVIDERS } });
    fireEvent.click(screen.getByTestId('chat-ids-save'));

    await waitFor(() => expect(updatePatientChatIds).toHaveBeenCalledWith(patientDetailMinimal.id, {
      familyChatId: FAMILY, providersChatId: PROVIDERS,
    }));
    expect(onSaved).toHaveBeenCalled();
  });

  it('o grupo escolhido para um papel some das opções do outro', async () => {
    render(<PatientChatIdsCard patient={patientDetailMinimal} />);
    fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));
    fireEvent.click(screen.getByTestId('chat-ids-search-btn'));
    await waitFor(() => expect(screen.getByTestId('chat-ids-candidates')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('chat-ids-family-select'), { target: { value: FAMILY } });

    const providersSelect = screen.getByTestId('chat-ids-providers-select') as HTMLSelectElement;
    const values = Array.from(providersSelect.querySelectorAll('option')).map(o => o.value);
    expect(values).not.toContain(FAMILY);
    expect(values).toContain(PROVIDERS);
  });

  it('salvar vazio desvincula (null nos dois)', async () => {
    updatePatientChatIds.mockResolvedValue({ id: 'x', familyChatId: null, providersChatId: null });
    render(<PatientChatIdsCard patient={patientDetailMinimal} />);
    fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));
    fireEvent.click(screen.getByTestId('chat-ids-save'));

    await waitFor(() => expect(updatePatientChatIds).toHaveBeenCalledWith(patientDetailMinimal.id, {
      familyChatId: null, providersChatId: null,
    }));
  });

  it('erro do backend no salvar (ex.: 409) aparece na tela e não fecha', async () => {
    updatePatientChatIds.mockRejectedValue(new Error('Chat id already linked to another patient'));
    render(<PatientChatIdsCard patient={patientDetailMinimal} />);
    fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));
    fireEvent.click(screen.getByTestId('chat-ids-save'));

    await waitFor(() => expect(screen.getByTestId('chat-ids-error'))
      .toHaveTextContent('Chat id already linked to another patient'));
    expect(screen.getByTestId('chat-ids-drawer')).toBeInTheDocument();
  });

  it('drawer abre já com o que o paciente tem gravado, sem option duplicada', () => {
    render(<PatientChatIdsCard patient={patientDetailFixture} />);
    fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));

    const familySelect = screen.getByTestId('chat-ids-family-select') as HTMLSelectElement;
    expect(familySelect.value).toBe(FAMILY);
    expect((screen.getByTestId('chat-ids-providers-select') as HTMLSelectElement).value).toBe(PROVIDERS);

    // Chave duplicada no <select> é warning do React e option fantasma na tela.
    const values = Array.from(familySelect.querySelectorAll('option')).map(o => o.value);
    expect(values.length).toBe(new Set(values).size);
  });

  it('a UI torna impossível escolher o mesmo grupo nos dois papéis', async () => {
    render(<PatientChatIdsCard patient={patientDetailMinimal} />);
    fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));
    fireEvent.click(screen.getByTestId('chat-ids-search-btn'));
    await waitFor(() => expect(screen.getByTestId('chat-ids-candidates')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('chat-ids-providers-select'), { target: { value: FAMILY } });
    // Tentar pôr o MESMO grupo em família não pega: a option foi removida.
    fireEvent.change(screen.getByTestId('chat-ids-family-select'), { target: { value: FAMILY } });

    expect((screen.getByTestId('chat-ids-family-select') as HTMLSelectElement).value).toBe('');
    fireEvent.click(screen.getByTestId('chat-ids-save'));
    await waitFor(() => expect(updatePatientChatIds).toHaveBeenCalledWith(patientDetailMinimal.id, {
      familyChatId: null, providersChatId: FAMILY,
    }));
  });

  it('candidato sem nome e sem contagem de membros não quebra a lista', async () => {
    getPatientChatCandidates.mockResolvedValue({
      candidates: [{ chatId: FAMILY, chatName: null, memberCount: null, score: 0.5, matchedTerms: [], linkedToOtherPatient: false }],
      totalGroups: 1,
    });
    render(<PatientChatIdsCard patient={patientDetailMinimal} />);
    fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));
    fireEvent.click(screen.getByTestId('chat-ids-search-btn'));

    await waitFor(() => expect(screen.getByTestId(`chat-candidate-${FAMILY}`)).toHaveTextContent(FAMILY));
    const options = Array.from(
      (screen.getByTestId('chat-ids-family-select') as HTMLSelectElement).querySelectorAll('option'),
    ).map(o => o.textContent);
    expect(options).toContain(FAMILY); // rótulo cai no próprio id
  });

  it('falha sem mensagem cai no texto traduzido de erro', async () => {
    getPatientChatCandidates.mockRejectedValue('sem message');
    render(<PatientChatIdsCard patient={patientDetailMinimal} />);
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
    fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));

    fireEvent.keyDown(document, { key: 'Enter' });
    expect(screen.getByTestId('chat-ids-drawer')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('chat-ids-drawer')).toBeNull(), { timeout: 2000 });
  });

  it('o X do cabeçalho fecha o drawer', async () => {
    render(<PatientChatIdsCard patient={patientDetailMinimal} />);
    fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));

    fireEvent.click(screen.getByLabelText(ptBR.admin.patients.detail.chatIdsCard.close));
    await waitFor(() => expect(screen.queryByTestId('chat-ids-drawer')).toBeNull(), { timeout: 2000 });
  });

  it('backdrop fecha o drawer', async () => {
    render(<PatientChatIdsCard patient={patientDetailMinimal} />);
    fireEvent.click(screen.getByTestId('chat-ids-edit-btn'));
    fireEvent.click(screen.getByTestId('chat-ids-backdrop'));

    await waitFor(() => expect(screen.queryByTestId('chat-ids-drawer')).toBeNull(), { timeout: 2000 });
  });
});
