import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VacancyProfessionCard } from '../VacancyProfessionCard';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const defaultProps = {
  profession: 'AT',
  requiredSex: 'F',
  diagnosis: 'TEA',
  talentumDescription: 'Se busca AT con experiencia en TEA.',
  ageRangeMin: 25,
  ageRangeMax: 45,
  zone: 'Palermo',
  workerAttributes: 'Paciente, empático',
  serviceType: ['AT'],
  schedule: null,
  onEditSchedule: vi.fn(),
  onEditDescription: vi.fn(),
};

function comEnforcement(permissions: string[], enforcement: AuthzContract['enforcement']) {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: {
      uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement,
    } as AuthzContract,
  });
}

describe('VacancyProfessionCard — lápis de descrição e horário (gate)', () => {
  beforeEach(() => {
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
  });

  it('PR-8b — enforcement=on sem talentum:update: lápis da descrição NÃO existe', () => {
    comEnforcement(['vacancy:update'], 'on');
    render(<VacancyProfessionCard {...defaultProps} />);
    expect(screen.queryByTestId('vacancy-edit-description-trigger')).not.toBeInTheDocument();
  });

  it('PR-8b — enforcement=on com talentum:update: lápis da descrição existe', () => {
    comEnforcement(['talentum:update'], 'on');
    render(<VacancyProfessionCard {...defaultProps} />);
    expect(screen.getByTestId('vacancy-edit-description-trigger')).toBeInTheDocument();
  });

  it('PR-8b — enforcement=on sem vacancy:update: lápis do horário NÃO existe', () => {
    comEnforcement(['talentum:update'], 'on');
    render(<VacancyProfessionCard {...defaultProps} />);
    expect(screen.queryByTestId('vacancy-edit-schedule-trigger')).not.toBeInTheDocument();
  });

  it('PR-8b — enforcement=on com vacancy:update: lápis do horário existe', () => {
    comEnforcement(['vacancy:update'], 'on');
    render(<VacancyProfessionCard {...defaultProps} />);
    expect(screen.getByTestId('vacancy-edit-schedule-trigger')).toBeInTheDocument();
  });

  it('PR-8b — com talentum:update e sem descrição: mostra a seção com o placeholder vazio', () => {
    comEnforcement(['talentum:update'], 'on');
    render(<VacancyProfessionCard {...defaultProps} talentumDescription={null} />);
    expect(screen.getByTestId('vacancy-edit-description-trigger')).toBeInTheDocument();
    expect(screen.getByText('admin.vacancyDetail.professionCard.descriptionEmpty')).toBeInTheDocument();
  });
});
