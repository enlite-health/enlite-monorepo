/**
 * AdmisionPage.emptySlots.test.tsx
 *
 * Quando o país não tem nenhuma atendente livre no horizonte, a API devolve
 * lista vazia — e o paciente NÃO pode ficar olhando uma tela em branco sem
 * explicação. Este teste prende esse estado nos DOIS idiomas usando os arquivos
 * de tradução REAIS (não um `t` que devolve a chave), porque o que se quer
 * provar aqui é que a frase existe e chega ao usuário, não que a chave foi
 * chamada.
 *
 * Também prende o contrário: com horários, a mensagem de vazio não aparece.
 * Sem isso o teste passaria mesmo se o bloco ficasse permanentemente visível.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18n from 'i18next';
import es from '@infrastructure/i18n/locales/es.json';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import AdmisionPage from '../AdmisionPage';

const mockGetSlots = vi.fn();
const mockCreateLead = vi.fn();

vi.mock('@infrastructure/http/LeadsApiService', () => ({
  LeadsApiService: {
    createLead: (...args: unknown[]) => mockCreateLead(...args),
    getAdmissionSlots: (...args: unknown[]) => mockGetSlots(...args),
    bookAdmission: vi.fn(),
  },
}));

/**
 * A tela de horários só existe depois que o lead foi criado, então o teste
 * percorre o formulário como o paciente percorre — é o caminho real, e é o que
 * garante que o estado vazio aparece onde ele de fato aparece.
 */
async function chegarNaTelaDeHorarios(): Promise<void> {
  fireEvent.change(screen.getByTestId('lead-serviceType'), { target: { value: 'cuidadores' } });
  fireEvent.click(screen.getByTestId('lead-requesterType-patient'));
  fireEvent.change(screen.getByTestId('lead-email'), { target: { value: 'paciente@example.com' } });
  fireEvent.change(screen.getByTestId('lead-phone'), { target: { value: '+5491122334455' } });
  fireEvent.click(screen.getByTestId('lead-consent'));
  fireEvent.click(screen.getByTestId('lead-submit'));
  await waitFor(() => expect(mockCreateLead).toHaveBeenCalled());
}

beforeEach(async () => {
  mockGetSlots.mockReset();
  mockCreateLead.mockReset();
  mockCreateLead.mockResolvedValue({ id: 'lead-0001' });
  // O setup global do vitest inicializa o i18n com `resources: {}` (só para
  // calar o warning), então as chaves passariam cruas. Aqui plugamos os
  // arquivos de tradução REAIS na instância que já existe — é o que faz este
  // teste falhar se alguém apagar a frase do locale.
  i18n.addResourceBundle('es', 'translation', es, true, true);
  i18n.addResourceBundle('pt-BR', 'translation', ptBR, true, true);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('AdmisionPage — sem horários disponíveis', () => {
  it('AR (es): a lista vazia vira uma frase, não uma tela em branco', async () => {
    mockGetSlots.mockResolvedValue([]);

    render(<AdmisionPage country="AR" />);
    await chegarNaTelaDeHorarios();

    const vazio = await screen.findByTestId('slot-empty');
    expect(vazio).toHaveTextContent(es.admission.slots.empty);
    // A frase real, não a chave — e em espanhol.
    expect(vazio.textContent).toContain('No hay horarios disponibles');
  });

  it('BR (pt): a mesma situação é explicada em português', async () => {
    mockGetSlots.mockResolvedValue([]);

    render(<AdmisionPage country="BR" />);
    await chegarNaTelaDeHorarios();

    const vazio = await screen.findByTestId('slot-empty');
    expect(vazio).toHaveTextContent(ptBR.admission.slots.empty);
    expect(vazio.textContent).toContain('Não há horários disponíveis');
  });

  it('com horários, a mensagem de vazio NÃO aparece', async () => {
    mockGetSlots.mockResolvedValue([
      { startISO: '2026-09-07T14:00:00-03:00', label: 'lunes 7 sep, 14:00' },
    ]);

    render(<AdmisionPage country="AR" />);
    await chegarNaTelaDeHorarios();

    await waitFor(() => expect(mockGetSlots).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('slot-empty')).not.toBeInTheDocument());
  });

  it('erro de carga é diferente de "não há horários"', async () => {
    mockGetSlots.mockRejectedValue(new Error('rede caiu'));

    render(<AdmisionPage country="AR" />);
    await chegarNaTelaDeHorarios();

    await screen.findByTestId('booking-error');
    expect(screen.queryByTestId('slot-empty')).not.toBeInTheDocument();
  });
});
