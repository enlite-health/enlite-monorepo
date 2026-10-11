/**
 * Faixa de aviso (vaga-le-do-servico-contratado, F4): uma linha por campo aberto (os 3 valores de `field`),
 * "marcar como atendido" chama o POST da F3 e some só com a linha daquele campo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { VacancySourceChangeNoticeBanner } from '../VacancySourceChangeNoticeBanner';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: unknown) => (typeof o === 'string' ? `${k}|fallback` : k) }),
}));
// Dublê do cliente HTTP escrito à mão (não `vi.fn`): o tinyspy do vitest 1.4 relança o erro de toda Promise
// rejeitada de um spy num `.then` sem `catch` e o vitest reporta "Unhandled Rejection" mesmo com o componente
// tratando a falha — medido neste teste.
const ackCalls: Array<[string, string]> = [];
let ackImpl: () => Promise<void> = async () => undefined;
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    acknowledgeVacancySourceChangeNotice: (vacancyId: string, field: string) => {
      ackCalls.push([vacancyId, field]);
      return ackImpl();
    },
  },
}));
const AT = '2026-10-10T15:00:00.000Z';

beforeEach(() => {
  ackCalls.length = 0;
  ackImpl = async () => undefined;
});

describe('VacancySourceChangeNoticeBanner', () => {
  it('sem avisos ([] / undefined / null) → não renderiza nada', () => {
    for (const notices of [[], undefined, null]) {
      const { container, unmount } = render(<VacancySourceChangeNoticeBanner vacancyId="v1" notices={notices} />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it('renderiza uma linha por campo, para os 3 valores de field', () => {
    render(
      <VacancySourceChangeNoticeBanner
        vacancyId="v1"
        notices={[
          { field: 'schedule', changed_at: AT },
          { field: 'providers_needed', changed_at: AT },
          { field: 'age_range', changed_at: AT },
        ]}
      />,
    );
    expect(screen.getByTestId('source-change-notice-banner')).toBeInTheDocument();
    for (const f of ['schedule', 'providers_needed', 'age_range']) {
      const row = screen.getByTestId(`source-change-notice-${f}`);
      expect(row).toHaveTextContent(`admin.vacancyDetail.sourceChangeNotice.message.${f}`);
    }
  });

  it('campo desconhecido cai na mensagem genérica (sem quebrar)', () => {
    render(<VacancySourceChangeNoticeBanner vacancyId="v1" notices={[{ field: 'xyz' as never, changed_at: AT }]} />);
    expect(screen.getByTestId('source-change-notice-xyz')).toBeInTheDocument();
  });

  it('"marcar como atendido" chama o POST com (vaga, campo), some só a linha daquele campo e avisa a página', async () => {
        const onAcknowledged = vi.fn();
    render(
      <VacancySourceChangeNoticeBanner
        vacancyId="v1"
        notices={[{ field: 'schedule', changed_at: AT }, { field: 'age_range', changed_at: AT }]}
        onAcknowledged={onAcknowledged}
      />,
    );
    fireEvent.click(screen.getByTestId('source-change-notice-ack-schedule'));
    await waitFor(() => expect(screen.queryByTestId('source-change-notice-schedule')).not.toBeInTheDocument());
    expect(ackCalls).toEqual([['v1', 'schedule']]);
    expect(screen.getByTestId('source-change-notice-age_range')).toBeInTheDocument();
    expect(onAcknowledged).toHaveBeenCalledTimes(1);
  });

  it('o último aviso fechado derruba a faixa inteira', async () => {
        render(<VacancySourceChangeNoticeBanner vacancyId="v1" notices={[{ field: 'schedule', changed_at: AT }]} />);
    fireEvent.click(screen.getByTestId('source-change-notice-ack-schedule'));
    await waitFor(() => expect(screen.queryByTestId('source-change-notice-banner')).not.toBeInTheDocument());
  });

  it('falha do POST (ex.: 404) → a linha FICA, com o erro, e a página não é avisada', async () => {
    ackImpl = async () => { throw new Error('No open notice'); };
    const onAcknowledged = vi.fn();
    render(<VacancySourceChangeNoticeBanner vacancyId="v1" notices={[{ field: 'schedule', changed_at: AT }]} onAcknowledged={onAcknowledged} />);
    fireEvent.click(screen.getByTestId('source-change-notice-ack-schedule'));
    await waitFor(() => expect(screen.getByTestId('source-change-notice-error-schedule')).toBeInTheDocument());
    expect(screen.getByTestId('source-change-notice-schedule')).toBeInTheDocument();
    expect(onAcknowledged).not.toHaveBeenCalled();
  });
});
