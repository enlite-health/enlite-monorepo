/**
 * VacancyMeetLinksCard.test.tsx — os 3 links fixos + o slot RECORRENTE (mig 291).
 * O que se afirma: validação, e o CORPO que vai para o PUT — `recurring` ausente
 * quando nada mudou, `null` quando limpou, objeto quando preencheu.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { VacancyMeetLinksCard } from '../VacancyMeetLinksCard';
import { toInputTime } from '../meetRecurringUtils';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && typeof opts === 'object') {
        let s = key;
        for (const [k, v] of Object.entries(opts)) s += ` ${k}=${String(v)}`;
        return s;
      }
      return key;
    },
  }),
}));

const mockUpdate = vi.fn();
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: { updateVacancyMeetLinks: (...a: unknown[]) => mockUpdate(...a) },
}));

const LINK = 'https://meet.google.com/abc-defg-hij';
const base = {
  vacancyId: 'v1',
  meetLink1: LINK, meetDatetime1: '2027-04-05T11:30:00Z',
  meetLink2: null, meetDatetime2: null,
  meetLink3: null, meetDatetime3: null,
  onSaved: vi.fn(),
};

describe('toInputTime', () => {
  it('normaliza TIME do Postgres para o input', () => {
    expect(toInputTime('08:30:00')).toBe('08:30');
    expect(toInputTime('8:30')).toBe('08:30');
    expect(toInputTime(null)).toBe('');
    expect(toInputTime('x')).toBe('');
  });
});

describe('VacancyMeetLinksCard — recorrente', () => {
  beforeEach(() => { vi.clearAllMocks(); mockUpdate.mockResolvedValue({}); });

  it('nasce com o recorrente da vaga preenchido e, sem mudança, o PUT NÃO manda `recurring`', async () => {
    render(<VacancyMeetLinksCard {...base} recurringWeekday={1} recurringTime="08:30:00" recurringLink={LINK} />);
    expect((screen.getByTestId('meet-recurring-weekday') as HTMLSelectElement).value).toBe('1');
    expect((screen.getByTestId('meet-recurring-time') as HTMLInputElement).value).toBe('08:30');
    expect((screen.getByTestId('meet-recurring-link') as HTMLInputElement).value).toBe(LINK);
    fireEvent.click(screen.getByTestId('meet-links-save'));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate).toHaveBeenCalledWith('v1', [LINK, null, null], undefined);
    await waitFor(() => expect(screen.getByTestId('meet-links-feedback')).toHaveTextContent('saveSuccess'));
    expect(base.onSaved).toHaveBeenCalled();
  });

  it('preencher dia + hora + sala manda `recurring` como objeto (weekday numérico)', async () => {
    render(<VacancyMeetLinksCard {...base} />);
    fireEvent.change(screen.getByTestId('meet-recurring-weekday'), { target: { value: '2' } });
    fireEvent.change(screen.getByTestId('meet-recurring-time'), { target: { value: '09:00' } });
    fireEvent.change(screen.getByTestId('meet-recurring-link'), { target: { value: ` ${LINK} ` } });
    fireEvent.click(screen.getByTestId('meet-links-save'));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('v1', [LINK, null, null], { weekday: 2, time: '09:00', link: LINK }));
  });

  it('limpar os três campos de um recorrente existente manda `recurring: null`', async () => {
    render(<VacancyMeetLinksCard {...base} recurringWeekday={1} recurringTime="08:30" recurringLink={LINK} />);
    fireEvent.change(screen.getByTestId('meet-recurring-weekday'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('meet-recurring-time'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('meet-recurring-link'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('meet-links-save'));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('v1', [LINK, null, null], null));
  });

  it('recorrente incompleto (só dia) → erro "incomplete", nada é enviado', async () => {
    render(<VacancyMeetLinksCard {...base} />);
    fireEvent.change(screen.getByTestId('meet-recurring-weekday'), { target: { value: '3' } });
    fireEvent.click(screen.getByTestId('meet-links-save'));
    expect(screen.getByTestId('meet-recurring-error')).toHaveTextContent('meetRecurring.incomplete');
    expect(mockUpdate).not.toHaveBeenCalled();
    // corrigir limpa o erro
    fireEvent.change(screen.getByTestId('meet-recurring-weekday'), { target: { value: '' } });
    expect(screen.queryByTestId('meet-recurring-error')).toBeNull();
  });

  it('sala fora do padrão → "invalidLink" (a hora é <input type="time">: o DOM só entrega HH:MM)', async () => {
    render(<VacancyMeetLinksCard {...base} />);
    fireEvent.change(screen.getByTestId('meet-recurring-weekday'), { target: { value: '1' } });
    fireEvent.change(screen.getByTestId('meet-recurring-time'), { target: { value: '08:30' } });
    fireEvent.change(screen.getByTestId('meet-recurring-link'), { target: { value: 'https://zoom.us/j/1' } });
    fireEvent.click(screen.getByTestId('meet-links-save'));
    expect(screen.getByTestId('meet-recurring-error')).toHaveTextContent('meetLinksCard.invalidLink');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('link fixo inválido bloqueia e mostra erro; corrigir limpa o erro', async () => {
    render(<VacancyMeetLinksCard {...base} />);
    const inputs = screen.getAllByPlaceholderText('https://meet.google.com/xxx-xxxx-xxx');
    fireEvent.change(inputs[1], { target: { value: 'nope' } });
    fireEvent.click(screen.getByTestId('meet-links-save'));
    expect(screen.getAllByText('admin.vacancyDetail.meetLinksCard.invalidLink')).toHaveLength(1);
    expect(mockUpdate).not.toHaveBeenCalled();
    fireEvent.change(inputs[1], { target: { value: '' } });
    expect(screen.queryByText('admin.vacancyDetail.meetLinksCard.invalidLink')).toBeNull();
  });

  it('erro do backend vira feedback de erro (Error com mensagem e sem mensagem)', async () => {
    mockUpdate.mockRejectedValueOnce(new Error('Invalid recurring meet link format'));
    render(<VacancyMeetLinksCard {...base} />);
    fireEvent.click(screen.getByTestId('meet-links-save'));
    await waitFor(() => expect(screen.getByTestId('meet-links-feedback')).toHaveTextContent('Invalid recurring meet link format'));
    mockUpdate.mockRejectedValueOnce('x');
    fireEvent.click(screen.getByTestId('meet-links-save'));
    await waitFor(() => expect(screen.getByTestId('meet-links-feedback')).toHaveTextContent('meetLinksCard.saveError'));
  });

  it('mostra a data resolvida do link fixo e o ícone de status; link preenchido ganha atalho externo', () => {
    render(<VacancyMeetLinksCard {...base} meetLink2="https://meet.google.com/zzz-zzzz-zzz" meetDatetime2={null} />);
    expect(screen.getByText(/2027/)).toBeInTheDocument();
    expect(screen.getAllByTitle('admin.vacancyDetail.meetLinksCard.openLink')).toHaveLength(2);
  });

  it('formatação de data que lança não derruba o card (catch do formatador)', () => {
    const spy = vi.spyOn(Date.prototype, 'toLocaleString').mockImplementation(() => { throw new Error('boom'); });
    render(<VacancyMeetLinksCard {...base} />);
    expect(screen.queryByText(/2027/)).toBeNull();
    spy.mockRestore();
  });
});
