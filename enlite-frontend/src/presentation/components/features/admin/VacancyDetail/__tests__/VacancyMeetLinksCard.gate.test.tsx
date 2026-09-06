import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VacancyMeetLinksCard } from '../VacancyMeetLinksCard';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: { updateVacancyMeetLinks: vi.fn() },
}));

const baseProps = {
  vacancyId: 'v1',
  meetLink1: null as string | null,
  meetDatetime1: null as string | null,
  meetLink2: null as string | null,
  meetDatetime2: null as string | null,
  meetLink3: null as string | null,
  meetDatetime3: null as string | null,
  onSaved: vi.fn(),
};


function comEnforcement(permissions: string[], enforcement: AuthzContract['enforcement']) {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: {
      uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement,
    } as AuthzContract,
  });
}

describe('VacancyMeetLinksCard', () => {
  beforeEach(() => {
    vi.mocked(AdminApiService.updateVacancyMeetLinks).mockReset();
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
  });

  it('D269 — enforcement=on sem vacancy:write: botão "salvar" NÃO existe', () => {
    comEnforcement([], 'on');
    render(<VacancyMeetLinksCard {...baseProps} />);
    expect(screen.queryByRole('button', { name: /saveLinks/ })).not.toBeInTheDocument();
  });

  it('D269 — enforcement=on com vacancy:write: botão "salvar" existe', () => {
    comEnforcement(['vacancy:write'], 'on');
    render(<VacancyMeetLinksCard {...baseProps} />);
    expect(screen.getByRole('button', { name: /saveLinks/ })).toBeInTheDocument();
  });
});
