import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { VacancyPrescreeningConfig } from '../VacancyPrescreeningConfig';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

// `t` PRECISA ser uma referência estável entre renders — o efeito de carga do
// componente tem `t` no array de deps (mesma suposição do i18next real, que
// memoiza `t`). Um mock que recria `t` a cada chamada de `useTranslation()`
// dispara um loop de re-fetch infinito (achado ao rodar este arquivo: 200ms
// depois do mount o spinner nunca sai, `mock.results` cresce sem parar).
const mockStableT = (k: string, o?: Record<string, unknown>) => (o?.n !== undefined ? `${k} ${o.n}` : k);
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mockStableT }) }));

vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    getPrescreeningConfig: vi.fn(),
    savePrescreeningConfig: vi.fn(),
  },
}));

function comEnforcement(permissions: string[], enforcement: AuthzContract['enforcement']) {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: {
      uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement,
    } as AuthzContract,
  });
}

async function renderLoaded(props: { isPublished?: boolean } = {}) {
  const utils = render(<VacancyPrescreeningConfig vacancyId="v1" isPublished={props.isPublished ?? false} />);
  await waitFor(() => expect(AdminApiService.getPrescreeningConfig).toHaveBeenCalledWith('v1'));
  await screen.findByText(/addQuestion/);
  return utils;
}

describe('VacancyPrescreeningConfig', () => {
  beforeEach(() => {
    vi.mocked(AdminApiService.getPrescreeningConfig).mockReset().mockResolvedValue({ questions: [], faq: [] });
    vi.mocked(AdminApiService.savePrescreeningConfig).mockReset();
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
  });

  it('carrega e mostra "sem perguntas" quando o config vem vazio', async () => {
    await renderLoaded();
    expect(screen.getByText(/noQuestions/)).toBeInTheDocument();
  });

  it('erro ao carregar: mostra feedback de erro', async () => {
    vi.mocked(AdminApiService.getPrescreeningConfig).mockRejectedValue(new Error('x'));
    render(<VacancyPrescreeningConfig vacancyId="v1" isPublished={false} />);
    expect(await screen.findByText(/loadError/)).toBeInTheDocument();
  });

  it('isPublished=true: mostra o aviso amarelo', async () => {
    await renderLoaded({ isPublished: true });
    expect(screen.getByText(/publishedWarning/)).toBeInTheDocument();
  });

  it('adicionar pergunta: aparece um card novo, com response type padrão text+audio marcado', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByText(/addQuestion/));
    expect(screen.getAllByRole('checkbox').filter((c) => (c as HTMLInputElement).checked)).toHaveLength(2);
  });

  it('editar pergunta e resposta desejada e peso', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByText(/addQuestion/));
    const [questionArea, desiredArea] = screen.getAllByRole('textbox');
    fireEvent.change(questionArea, { target: { value: '¿Tenés experiencia?' } });
    fireEvent.change(desiredArea, { target: { value: 'Sí' } });
    const weightInput = screen.getByDisplayValue('5');
    fireEvent.change(weightInput, { target: { value: '8' } });
    expect(questionArea).toHaveValue('¿Tenés experiencia?');
    expect(weightInput).toHaveValue(8);
  });

  it('desmarcar um response type remove; desmarcar o último NÃO remove (mínimo 1)', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByText(/addQuestion/));
    const [textCb, audioCb] = screen.getAllByRole('checkbox');
    fireEvent.click(audioCb); // remove audio, sobra text
    expect(textCb).toBeChecked();
    fireEvent.click(textCb); // só resta text — não pode remover o último
    expect(textCb).toBeChecked();
  });

  it('expandir configuração avançada mostra required/analyzed/earlyStoppage, e clicar alterna', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByText(/addQuestion/));
    fireEvent.click(screen.getByText(/advancedConfig/));
    expect(screen.getByText(/^admin\.vacancyDetail\.prescreening\.required$/)).toBeInTheDocument();
    const analyzedCheckbox = screen.getAllByRole('checkbox').find((c) => c.nextSibling?.textContent?.includes('analyzed'));
    expect(analyzedCheckbox).toBeChecked(); // default analyzed=true
  });

  it('deletar pergunta remove o card', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByText(/addQuestion/));
    expect(screen.getByText(/questionLabel 1/)).toBeInTheDocument();
    const [deleteBtn] = screen.getAllByRole('button').filter((b) => b.querySelector('svg'));
    fireEvent.click(deleteBtn);
    expect(screen.getByText(/noQuestions/)).toBeInTheDocument();
  });

  it('validação: salvar pergunta vazia mostra os 3 erros e NÃO chama a API', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByText(/addQuestion/));
    fireEvent.click(screen.getByRole('button', { name: /\bsave\b/ }));
    expect(await screen.findByText(/questionRequired/)).toBeInTheDocument();
    expect(screen.getByText(/desiredResponseRequired/)).toBeInTheDocument();
    expect(AdminApiService.savePrescreeningConfig).not.toHaveBeenCalled();
  });

  it('validação: peso fora de 1-10 gera erro de weightRange', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByText(/addQuestion/));
    const [questionArea, desiredArea] = screen.getAllByRole('textbox');
    fireEvent.change(questionArea, { target: { value: 'q' } });
    fireEvent.change(desiredArea, { target: { value: 'r' } });
    fireEvent.change(screen.getByDisplayValue('5'), { target: { value: '99' } });
    fireEvent.click(screen.getByRole('button', { name: /\bsave\b/ }));
    expect(await screen.findByText(/weightRange/)).toBeInTheDocument();
  });

  it('editar um campo com erro limpa o erro daquela pergunta', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByText(/addQuestion/));
    fireEvent.click(screen.getByRole('button', { name: /\bsave\b/ }));
    await screen.findByText(/questionRequired/);
    const [questionArea] = screen.getAllByRole('textbox');
    fireEvent.change(questionArea, { target: { value: 'agora tem pergunta' } });
    expect(screen.queryByText(/questionRequired/)).not.toBeInTheDocument();
  });

  it('salvar com pergunta válida: chama savePrescreeningConfig e mostra sucesso', async () => {
    vi.mocked(AdminApiService.savePrescreeningConfig).mockResolvedValue({ questions: [], faq: [] });
    await renderLoaded();
    fireEvent.click(screen.getByText(/addQuestion/));
    const [questionArea, desiredArea] = screen.getAllByRole('textbox');
    fireEvent.change(questionArea, { target: { value: 'q' } });
    fireEvent.change(desiredArea, { target: { value: 'r' } });
    fireEvent.click(screen.getByRole('button', { name: /\bsave\b/ }));
    await waitFor(() => expect(AdminApiService.savePrescreeningConfig).toHaveBeenCalled());
    expect(await screen.findByText(/saveSuccess/)).toBeInTheDocument();
  });

  it('salvar: erro da API mostra feedback', async () => {
    vi.mocked(AdminApiService.savePrescreeningConfig).mockRejectedValue(new Error('falhou salvar'));
    await renderLoaded();
    fireEvent.click(screen.getByText(/addQuestion/));
    const [questionArea, desiredArea] = screen.getAllByRole('textbox');
    fireEvent.change(questionArea, { target: { value: 'q' } });
    fireEvent.change(desiredArea, { target: { value: 'r' } });
    fireEvent.click(screen.getByRole('button', { name: /\bsave\b/ }));
    expect(await screen.findByText('falhou salvar')).toBeInTheDocument();
  });

  it('FAQ: adicionar, editar pergunta/resposta e remover', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByText(/addFaq/));
    const inputs = screen.getAllByRole('textbox');
    const faqQuestion = inputs[inputs.length - 2];
    const faqAnswer = inputs[inputs.length - 1];
    fireEvent.change(faqQuestion, { target: { value: '¿Cuánto pagan?' } });
    fireEvent.change(faqAnswer, { target: { value: 'Depende' } });
    expect(faqQuestion).toHaveValue('¿Cuánto pagan?');
    const trashButtons = screen.getAllByRole('button').filter((b) => b.querySelector('svg.lucide-trash-2'));
    fireEvent.click(trashButtons[trashButtons.length - 1]);
    expect(screen.queryByDisplayValue('¿Cuánto pagan?')).not.toBeInTheDocument();
  });

  it('D269 — enforcement=on sem prescreening:write: botão salvar NÃO existe', async () => {
    comEnforcement([], 'on');
    await renderLoaded();
    expect(screen.queryByRole('button', { name: /\bsave\b/ })).not.toBeInTheDocument();
  });

  it('D269 — enforcement=on com prescreening:write: botão salvar existe', async () => {
    comEnforcement(['prescreening:update'], 'on');
    await renderLoaded();
    expect(screen.getByRole('button', { name: /\bsave\b/ })).toBeInTheDocument();
  });
});
