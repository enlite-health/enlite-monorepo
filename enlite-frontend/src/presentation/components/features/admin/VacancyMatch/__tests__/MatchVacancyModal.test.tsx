import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MatchVacancyModal } from '../MatchVacancyModal';
import type { VacancyForMatch } from '../matchModalHelpers';
import type { SavedCandidate } from '../../../../../../types/match';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'es' },
  }),
}));

const enqueue = vi.fn();

vi.mock('@presentation/stores/inviteProgressStore', () => ({
  useInviteProgressStore: (selector: (s: { enqueue: typeof enqueue }) => unknown) =>
    selector({ enqueue }),
}));

const candidate: SavedCandidate = {
  workerId: 'w1',
  workerName: 'Worker Uno',
  workerPhone: '+5411000',
  occupation: 'AT',
  workZone: 'Z',
  distanceKm: 3,
  activeCasesCount: 0,
  overallStatus: null,
  documentStatus: null,
  matchScore: 10,
  internalNotes: null,
  alreadyApplied: false,
  messagedAt: null,
};

vi.mock('@hooks/admin/useVacancyMatch', () => ({
  useVacancyMatch: () => ({
    results: {
      jobPostingId: 'v1',
      lastMatchAt: null,
      totalCandidates: 1,
      candidates: [candidate],
    },
    isLoading: false,
    isRunning: false,
    error: null,
    runMatch: vi.fn(),
    markMessaged: vi.fn(),
  }),
}));

// Vaga SEM nenhum link de Meet: o convite não depende dele (o backend só
// recebe workerId + jobPostingId), então o modal não pode travar por isso.
const vacancyWithoutMeetLinks: VacancyForMatch = {
  meet_link_1: null,
  meet_link_2: '',
  meet_link_3: undefined,
};

function renderModal() {
  return render(
    <MemoryRouter>
      <MatchVacancyModal
        vacancyId="v1"
        vacancy={vacancyWithoutMeetLinks}
        onClose={vi.fn()}
      />
    </MemoryRouter>,
  );
}

describe('MatchVacancyModal — convite sem link de Meet na vaga', () => {
  beforeEach(() => enqueue.mockClear());

  it('não mostra o aviso de "sem enlaces de reunión"', () => {
    renderModal();
    expect(screen.queryByText('admin.match.missingMeetLinks.title')).toBeNull();
    expect(screen.queryByText('admin.match.missingMeetLinks.goToLinks')).toBeNull();
  });

  it('habilita "Invitar seleccionados" com candidato marcado e enfileira o convite', () => {
    renderModal();
    const invite = screen.getByRole('button', { name: 'admin.match.inviteSelected' });
    expect(invite).toBeDisabled();

    // "Seleccionar todos" do agrupamento de Km marca o único candidato.
    fireEvent.click(screen.getByLabelText('admin.match.selectAllInGroup'));

    expect(invite).toBeEnabled();
    fireEvent.click(invite);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0]).toBe('v1');
    expect(enqueue.mock.calls[0][1]).toEqual([candidate]);
  });
});
