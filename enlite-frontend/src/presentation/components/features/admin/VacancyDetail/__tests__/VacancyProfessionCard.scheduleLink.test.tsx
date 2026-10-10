/**
 * Lápis do horário (vaga-le-do-servico-contratado, F4): horário do SERVIÇO = link para a ficha do paciente
 * na aba "Servicio Contratado"; vaga manual (sem serviço) = o modal de sempre. Sem permissão de abrir a ficha
 * = texto sem link (nada de 403 na cara).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';
import { VacancyProfessionCard } from '../VacancyProfessionCard';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const base = {
  profession: 'AT',
  requiredSex: null,
  diagnoses: [],
  diagnosesUnavailable: false,
  talentumDescription: null,
  ageRangeMin: null,
  ageRangeMax: null,
  zone: null,
  workerAttributes: null,
  serviceType: null,
  schedule: { lunes: [{ start: '08:00', end: '12:00' }] },
};

function comAcesso(permissions: string[], enforcement: AuthzContract['enforcement']) {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement } as AuthzContract,
  });
}

beforeEach(() => {
  useAdminAuthStore.setState({ authzStatus: 'idle', authz: null } as never);
});

const renderCard = (props: Record<string, unknown>) =>
  render(
    <MemoryRouter>
      <VacancyProfessionCard {...base} {...props} />
    </MemoryRouter>,
  );

describe('VacancyProfessionCard — lápis do horário', () => {
  it('horário do serviço → LINK para a aba Servicio Contratado; o modal NÃO abre', () => {
    const onEditSchedule = vi.fn();
    renderCard({ onEditSchedule, scheduleServicePatientId: 'p-7' });
    const link = screen.getByTestId('vacancy-schedule-service-link');
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', '/admin/patients/p-7?tab=contractedService');
    expect(screen.queryByTestId('vacancy-edit-schedule-trigger')).not.toBeInTheDocument();
    fireEvent.click(link);
    expect(onEditSchedule).not.toHaveBeenCalled();
  });

  it('vaga manual (sem serviço) → botão que abre o modal; nenhum link', () => {
    const onEditSchedule = vi.fn();
    renderCard({ onEditSchedule, scheduleServicePatientId: null });
    fireEvent.click(screen.getByTestId('vacancy-edit-schedule-trigger'));
    expect(onEditSchedule).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('vacancy-schedule-service-link')).not.toBeInTheDocument();
  });

  it('horário do serviço SEM permissão de ver o paciente (enforcement on, sem patient:read) → texto, sem link', () => {
    comAcesso(['vacancy:read', 'vacancy:update'], 'on');
    renderCard({ onEditSchedule: vi.fn(), scheduleServicePatientId: 'p-7' });
    expect(screen.queryByTestId('vacancy-schedule-service-link')).not.toBeInTheDocument();
    expect(screen.queryByTestId('vacancy-edit-schedule-trigger')).not.toBeInTheDocument();
    expect(screen.getByTestId('vacancy-schedule-service-note')).toHaveTextContent('admin.vacancyDetail.professionCard.scheduleFromService');
  });

  it('com patient:read mas sem nenhuma célula da aba Servicio Contratado → texto, sem link', () => {
    comAcesso(['patient:read'], 'on');
    renderCard({ onEditSchedule: vi.fn(), scheduleServicePatientId: 'p-7' });
    expect(screen.queryByTestId('vacancy-schedule-service-link')).not.toBeInTheDocument();
    expect(screen.getByTestId('vacancy-schedule-service-note')).toBeInTheDocument();
  });

  it('patient:read + patient_services:read (enforcement on) → link', () => {
    comAcesso(['patient:read', 'patient_services:read'], 'on');
    renderCard({ onEditSchedule: vi.fn(), scheduleServicePatientId: 'p-7' });
    expect(screen.getByTestId('vacancy-schedule-service-link')).toHaveAttribute('href', '/admin/patients/p-7?tab=contractedService');
  });
});
