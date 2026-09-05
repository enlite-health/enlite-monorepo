/**
 * Spec 014 US-D5 (navegação): criar paciente já não navega para a ficha — só refetch da lista
 * (auditoria §3/§4-D, `AdminPatientsPage.tsx:262-269`). `PatientCreateModal.onCreated(id)` já
 * manda o id criado; o handler o ignorava.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, d?: unknown) => (typeof d === 'string' ? d : k) }) }));

const patientsData = {
  patients: [], total: 0, stats: null, isLoading: false, error: null, refetch: vi.fn(),
};
vi.mock('@hooks/admin/usePatientsData', () => ({ usePatientsData: () => patientsData }));

vi.mock('@presentation/components/features/admin/PatientCreateModal', () => ({
  PatientCreateModal: (p: { onCreated: (id: string) => void }) => (
    <button data-testid="create-modal-stub" onClick={() => p.onCreated('new-patient-id-123')}>
      criar
    </button>
  ),
}));

import { AdminPatientsPage } from '../AdminPatientsPage';

describe('AdminPatientsPage — criar paciente navega para a ficha (US-D5)', () => {
  beforeEach(() => { navigate.mockReset(); patientsData.refetch.mockReset(); });

  it('após criar, navega para /admin/patients/:id (o id que o modal devolveu)', async () => {
    const user = userEvent.setup();
    render(<AdminPatientsPage />);
    await user.click(screen.getByTestId('new-patient-btn'));
    await user.click(screen.getByTestId('create-modal-stub'));
    expect(navigate).toHaveBeenCalledWith('/admin/patients/new-patient-id-123');
  });
});
