import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VacancyMeetLinksRow } from '../VacancyMeetLinksRow';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const emptyProps = {
  meetLink1: null,
  meetDatetime1: null,
  meetLink2: null,
  meetDatetime2: null,
  meetLink3: null,
  meetDatetime3: null,
};

// ── Null handling ────────────────────────────────────────────────────────────

describe('VacancyMeetLinksRow — no slots', () => {
  it('returns null (renders nothing) when all slots are empty', () => {
    const { container } = render(<VacancyMeetLinksRow {...emptyProps} />);
    expect(container.firstChild).toBeNull();
  });
});

// ── Render with slots ────────────────────────────────────────────────────────

describe('VacancyMeetLinksRow — with slots', () => {
  it('renders section title when at least one slot has data', () => {
    render(
      <VacancyMeetLinksRow
        {...emptyProps}
        meetLink1="https://meet.google.com/abc-defg-hij"
        meetDatetime1="2026-05-10T13:00:00Z"
      />,
    );
    expect(
      screen.getByText('admin.vacancyDetail.meetLinksRow.title'),
    ).toBeInTheDocument();
  });

  it('renders only filled slots (skips null ones)', () => {
    render(
      <VacancyMeetLinksRow
        {...emptyProps}
        meetLink1="https://meet.google.com/abc-defg-hij"
        meetDatetime1="2026-05-10T13:00:00Z"
        meetLink2={null}
        meetDatetime2={null}
        meetLink3="https://meet.google.com/xyz-abcd-efg"
        meetDatetime3="2026-05-12T15:00:00Z"
      />,
    );
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(2);
  });

  it('renders a link element when meetLink is provided', () => {
    render(
      <VacancyMeetLinksRow
        {...emptyProps}
        meetLink1="https://meet.google.com/abc-defg-hij"
        meetDatetime1="2026-05-10T13:00:00Z"
      />,
    );
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute(
      'href',
      'https://meet.google.com/abc-defg-hij',
    );
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('renders span (not link) when only datetime is provided without link', () => {
    render(
      <VacancyMeetLinksRow
        {...emptyProps}
        meetLink1={null}
        meetDatetime1="2026-05-10T13:00:00Z"
      />,
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('slot RECORRENTE sozinho renderiza a seção com a pill "todos os <dia> às <hora>" apontando para a sala', () => {
    render(
      <VacancyMeetLinksRow
        meetLink1={null} meetDatetime1={null} meetLink2={null} meetDatetime2={null} meetLink3={null} meetDatetime3={null}
        recurringWeekday={1} recurringTime="08:30:00" recurringLink="https://meet.google.com/rec-urri-ngx"
      />,
    );
    const pill = screen.getByTestId('meet-recurring-pill');
    expect(pill).toHaveAttribute('href', 'https://meet.google.com/rec-urri-ngx');
    // o mock de i18n devolve a chave; a interpolação (dia/hora) é do i18next real — coberta no e2e
    expect(pill.textContent).toContain('meetRecurring.every');
  });

  it('recorrente incompleto (sem sala) não conta como slot: continua renderizando nada', () => {
    const { container } = render(
      <VacancyMeetLinksRow
        meetLink1={null} meetDatetime1={null} meetLink2={null} meetDatetime2={null} meetLink3={null} meetDatetime3={null}
        recurringWeekday={1} recurringTime="08:30" recurringLink={null}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('datetime inválido não derruba a linha: a pill mostra o texto cru (catch do formatador)', () => {
    render(
      <VacancyMeetLinksRow
        meetLink1={null} meetDatetime1="not-a-date" meetLink2={null} meetDatetime2={null} meetLink3={null} meetDatetime3={null}
      />,
    );
    expect(screen.getByText('not-a-date')).toBeInTheDocument();
  });
});
