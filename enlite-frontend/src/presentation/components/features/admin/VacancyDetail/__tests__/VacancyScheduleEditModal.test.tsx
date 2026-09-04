import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { VacancyScheduleEditModal } from '../VacancyScheduleEditModal';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';
import type { DayScheduleSlot } from '@presentation/components/molecules/DayScheduleEditor';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: { updateVacancy: vi.fn() },
}));

// Stub simples: expõe um botão que injeta 1 slot válido, pra exercitar
// hasValidSlot sem reimplementar o editor de dias/horários inteiro.
vi.mock('@presentation/components/molecules/DayScheduleEditor', () => ({
  DayScheduleEditor: ({ onChange }: { onChange: (v: DayScheduleSlot[]) => void }) => (
    <button
      type="button"
      data-testid="add-valid-slot"
      onClick={() => onChange([{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }])}
    >
      add slot
    </button>
  ),
}));

const baseProps = {
  isOpen: true,
  vacancyId: 'v1',
  vacancy: {},
  onClose: vi.fn(),
  onSuccess: vi.fn(),
};

function comEnforcement(permissions: string[], enforcement: AuthzContract['enforcement']) {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: {
      uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement,
    } as AuthzContract,
  });
}

describe('VacancyScheduleEditModal', () => {
  beforeEach(() => {
    vi.mocked(AdminApiService.updateVacancy).mockReset();
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
  });

  it('isOpen=false: não renderiza nada', () => {
    render(<VacancyScheduleEditModal {...baseProps} isOpen={false} />);
    expect(screen.queryByTestId('vacancy-schedule-modal')).not.toBeInTheDocument();
  });

  it('hidrata o array de slots do formato JSONB (Array<{dayOfWeek,startTime,endTime}>)', () => {
    render(<VacancyScheduleEditModal {...baseProps} vacancy={{ schedule: [{ dayOfWeek: 2, startTime: '09:00', endTime: '13:00' }] }} />);
    expect(screen.getByTestId('vacancy-schedule-modal')).toBeInTheDocument();
  });

  it('hidrata o formato Record<diaNome, slots> normalizado pelo backend', () => {
    render(<VacancyScheduleEditModal {...baseProps} vacancy={{ schedule: { lunes: [{ start: '09:00', end: '13:00' }], diaInvalido: [{ start: '01:00', end: '02:00' }] } }} />);
    expect(screen.getByTestId('vacancy-schedule-modal')).toBeInTheDocument();
  });

  it('vacancy sem schedule / não-objeto: hidrata vazio sem quebrar', () => {
    render(<VacancyScheduleEditModal {...baseProps} vacancy={null} />);
    expect(screen.getByTestId('vacancy-schedule-modal')).toBeInTheDocument();
  });

  it('salvar sem nenhum slot: mostra erro de vazio, NÃO chama a API', async () => {
    render(<VacancyScheduleEditModal {...baseProps} />);
    fireEvent.click(screen.getByTestId('vacancy-schedule-save'));
    expect(await screen.findByText('admin.vacancyDetail.scheduleEditor.errorEmpty')).toBeInTheDocument();
    expect(AdminApiService.updateVacancy).not.toHaveBeenCalled();
  });

  it('salvar com slot válido: chama updateVacancy e onSuccess', async () => {
    vi.mocked(AdminApiService.updateVacancy).mockResolvedValue({} as never);
    render(<VacancyScheduleEditModal {...baseProps} />);
    fireEvent.click(screen.getByTestId('add-valid-slot'));
    fireEvent.click(screen.getByTestId('vacancy-schedule-save'));
    await waitFor(() => expect(AdminApiService.updateVacancy).toHaveBeenCalledWith('v1', {
      schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }],
    }));
    expect(baseProps.onSuccess).toHaveBeenCalled();
  });

  it('salvar: erro da API mostra a mensagem', async () => {
    vi.mocked(AdminApiService.updateVacancy).mockRejectedValue(new Error('falhou horário'));
    render(<VacancyScheduleEditModal {...baseProps} />);
    fireEvent.click(screen.getByTestId('add-valid-slot'));
    fireEvent.click(screen.getByTestId('vacancy-schedule-save'));
    expect(await screen.findByText('falhou horário')).toBeInTheDocument();
  });

  it('clicar no backdrop fecha o modal', () => {
    render(<VacancyScheduleEditModal {...baseProps} />);
    fireEvent.click(screen.getByTestId('vacancy-schedule-modal-backdrop'));
    expect(baseProps.onClose).toHaveBeenCalled();
  });

  it('botão cancelar chama onClose', () => {
    render(<VacancyScheduleEditModal {...baseProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'admin.vacancyDetail.scheduleEditor.cancel' }));
    expect(baseProps.onClose).toHaveBeenCalled();
  });

  it('D269 — enforcement=on sem vacancy:write: botão salvar NÃO existe', () => {
    comEnforcement([], 'on');
    render(<VacancyScheduleEditModal {...baseProps} />);
    expect(screen.queryByTestId('vacancy-schedule-save')).not.toBeInTheDocument();
  });

  it('D269 — enforcement=on com vacancy:write: botão salvar existe', () => {
    comEnforcement(['vacancy:write'], 'on');
    render(<VacancyScheduleEditModal {...baseProps} />);
    expect(screen.getByTestId('vacancy-schedule-save')).toBeInTheDocument();
  });
});
