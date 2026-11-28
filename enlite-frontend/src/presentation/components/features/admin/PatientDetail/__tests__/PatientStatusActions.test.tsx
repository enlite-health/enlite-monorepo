/**
 * PatientStatusActions — F3 (estado-automatico-do-paciente, D5/D9): a lista de ações vem do SERVIDOR; a tela não decide FSM, permissão nem
 * destino. Pausar abre o motivo (obrigatório) e a nota (clínica, mascarada); sair de Suspendido abre o motivo de saída; as demais agem no
 * clique. O corpo do POST nunca leva destino. Ação bloqueada aparece desabilitada com o aviso de alocação viva.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import es from '@infrastructure/i18n/locales/es.json';
import { patientDetailFixture } from './patientDetailFixture';

const translations = ptBR as Record<string, any>;
function t(key: string, opts?: any): string {
  let cur: any = translations;
  for (const p of key.split('.')) cur = cur?.[p];
  if (typeof cur === 'string') return typeof opts === 'object' && opts ? cur.replace(/\{\{(\w+)\}\}/g, (_: string, k: string) => opts[k] ?? _) : cur;
  if (typeof opts === 'string') return opts;
  if (typeof opts === 'object' && typeof opts?.defaultValue === 'string') return opts.defaultValue;
  return key;
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));

const getPatientStatusActions = vi.fn();
const performPatientStatusAction = vi.fn();
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    getPatientStatusActions: (...a: unknown[]) => getPatientStatusActions(...a),
    performPatientStatusAction: (...a: unknown[]) => performPatientStatusAction(...a),
  },
}));

import { PatientApiError } from '@infrastructure/http/AdminPatientsApiService';
import { PatientStatusActions } from '../PatientStatusActions';
import { chooseCombo } from '@presentation/components/atoms/Combobox/testUtils';

const base = { ...patientDetailFixture, admissionStatus: 'DONE' as const, onHoldReason: null, onHoldNote: null };
const lista = (current: string, actions: Array<Record<string, unknown>>) => ({ current, actions });
const acao = (nome: string, destino: string, exige: string[] = [], extra: Record<string, unknown> = {}) => ({ acao: nome, destino, via: 'fluxo', exige, ...extra });

describe('PatientStatusActions', () => {
  beforeEach(() => {
    getPatientStatusActions.mockReset();
    performPatientStatusAction.mockReset().mockResolvedValue({ id: base.id, action: 'retomar', from: 'ON_HOLD', status: 'SEARCHING' });
  });

  it('não lê nem renderiza para paciente ainda no funil de admissão', () => {
    const { container } = render(<PatientStatusActions patient={{ ...base, status: 'ADMISSION', admissionStatus: 'ADMISSION' }} onSaved={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
    expect(getPatientStatusActions).not.toHaveBeenCalled();
  });

  it('renderiza SÓ o que o servidor devolveu, com o rótulo traduzido e o destino re-derivado no title', async () => {
    getPatientStatusActions.mockResolvedValue(lista('ON_HOLD', [acao('retomar', 'SEARCHING'), acao('dar_baja', 'DISCHARGED')]));
    render(<PatientStatusActions patient={{ ...base, status: 'ON_HOLD' }} onSaved={vi.fn()} />);
    const retomar = await screen.findByTestId('patient-status-action-retomar');
    expect(retomar).toHaveTextContent('Retomar');
    expect(retomar).toHaveAttribute('title', 'Passará para «Búsqueda»'.replace('Búsqueda', t('admin.patients.statusOptions.SEARCHING')));
    expect(screen.getByTestId('patient-status-action-dar_baja')).toHaveTextContent('Dar baixa');
    expect(screen.queryByTestId('patient-status-action-reativar')).not.toBeInTheDocument();
  });

  it('retomar de En espera age no clique e o POST NÃO leva destino', async () => {
    getPatientStatusActions.mockResolvedValue(lista('ON_HOLD', [acao('retomar', 'SEARCHING')]));
    const onSaved = vi.fn();
    render(<PatientStatusActions patient={{ ...base, status: 'ON_HOLD' }} onSaved={onSaved} />);
    fireEvent.click(await screen.findByTestId('patient-status-action-retomar'));
    await waitFor(() => expect(performPatientStatusAction).toHaveBeenCalledWith(base.id, { action: 'retomar' }));
    expect(Object.keys(performPatientStatusAction.mock.calls[0][1])).not.toContain('destino');
    expect(onSaved).toHaveBeenCalled();
  });

  it('reativar (Baja) age no clique, sem destino no corpo', async () => {
    getPatientStatusActions.mockResolvedValue(lista('DISCHARGED', [acao('reativar', 'SEARCHING')]));
    render(<PatientStatusActions patient={{ ...base, status: 'DISCHARGED' }} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('patient-status-action-reativar'));
    await waitFor(() => expect(performPatientStatusAction).toHaveBeenCalledWith(base.id, { action: 'reativar' }));
  });

  it('pausar pede o motivo: confirmar fica desabilitado até escolher; o corpo leva motivo e nota', async () => {
    getPatientStatusActions.mockResolvedValue(lista('ACTIVE', [acao('pausar', 'ON_HOLD', ['onHoldReason'])]));
    render(<PatientStatusActions patient={{ ...base, status: 'ACTIVE' }} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('patient-status-action-pausar'));
    expect(performPatientStatusAction).not.toHaveBeenCalled();
    const confirmar = screen.getByTestId('patient-status-action-confirm');
    expect(confirmar).toBeDisabled();
    chooseCombo(screen.getByTestId('patient-status-action-reason'), 'Escola'); // SCHOOL
    fireEvent.change(screen.getByTestId('patient-status-action-note'), { target: { value: 'sem texto real' } });
    expect(confirmar).not.toBeDisabled();
    fireEvent.click(confirmar);
    await waitFor(() => expect(performPatientStatusAction).toHaveBeenCalledWith(base.id, { action: 'pausar', onHoldReason: 'SCHOOL', onHoldNote: 'sem texto real' }));
  });

  it('nota redigida para este ator: o campo é desabilitado e a CHAVE nem vai no corpo', async () => {
    getPatientStatusActions.mockResolvedValue(lista('ACTIVE', [acao('pausar', 'ON_HOLD', ['onHoldReason'])]));
    render(<PatientStatusActions patient={{ ...base, status: 'ACTIVE', onHoldNoteRedacted: true }} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('patient-status-action-pausar'));
    expect(screen.getByTestId('patient-status-action-note')).toBeDisabled();
    chooseCombo(screen.getByTestId('patient-status-action-reason'), 'Convênio / obra social'); // INSURER
    fireEvent.click(screen.getByTestId('patient-status-action-confirm'));
    await waitFor(() => expect(performPatientStatusAction).toHaveBeenCalledWith(base.id, { action: 'pausar', onHoldReason: 'INSURER' }));
  });

  it('retomar de Suspendido sem motivo fica desabilitado; com motivo passa e o corpo leva o motivo de saída', async () => {
    getPatientStatusActions.mockResolvedValue(lista('SUSPENDED', [acao('retomar', 'SEARCHING', ['suspensionExitReason'])]));
    render(<PatientStatusActions patient={{ ...base, status: 'SUSPENDED' }} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('patient-status-action-retomar'));
    const confirmar = screen.getByTestId('patient-status-action-confirm');
    expect(confirmar).toBeDisabled();
    chooseCombo(screen.getByTestId('patient-status-action-exit-reason'), 'Retomou o serviço (fim de férias/internação)'); // RESUMED_SERVICE
    expect(confirmar).not.toBeDisabled();
    fireEvent.click(confirmar);
    await waitFor(() => expect(performPatientStatusAction).toHaveBeenCalledWith(base.id, { action: 'retomar', suspensionExitReason: 'RESUMED_SERVICE' }));
  });

  it('alocação viva: todas as ações desabilitadas e o aviso visível', async () => {
    getPatientStatusActions.mockResolvedValue(lista('ON_HOLD', [acao('retomar', 'ACTIVE', [], { blockedBy: ['ACTIVE_ALLOCATION'] }), acao('dar_baja', 'DISCHARGED', [], { blockedBy: ['ACTIVE_ALLOCATION'] })]));
    render(<PatientStatusActions patient={{ ...base, status: 'ON_HOLD' }} onSaved={vi.fn()} />);
    expect(await screen.findByTestId('patient-status-action-retomar')).toBeDisabled();
    expect(screen.getByTestId('patient-status-action-dar_baja')).toBeDisabled();
    expect(screen.getByTestId('patient-status-actions-locked-notice')).toHaveTextContent(t('admin.patients.status.friendly.lockedByAllocation'));
  });

  it('recusa do servidor vira frase amigável (sem código técnico) e a lista é relida', async () => {
    getPatientStatusActions.mockResolvedValue(lista('ON_HOLD', [acao('retomar', 'SEARCHING')]));
    performPatientStatusAction.mockRejectedValue(new PatientApiError('x', 422, { success: false, error: 'x', code: 'PATIENT_STATUS_LOCKED_BY_ALLOCATION' } as never));
    render(<PatientStatusActions patient={{ ...base, status: 'ON_HOLD' }} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('patient-status-action-retomar'));
    expect(await screen.findByTestId('patient-status-action-error')).toHaveTextContent(t('admin.patients.status.friendly.lockedByAllocation'));
    expect(screen.getByTestId('patient-status-action-error')).not.toHaveTextContent('PATIENT_STATUS');
    await waitFor(() => expect(getPatientStatusActions).toHaveBeenCalledTimes(2));
  });

  it('erro sem código mapeado: mostra a mensagem i18n genérica, nunca o `message` cru do backend', async () => {
    getPatientStatusActions.mockResolvedValue(lista('ON_HOLD', [acao('retomar', 'SEARCHING')]));
    performPatientStatusAction.mockRejectedValue(new Error('duplicate key value violates constraint patients_pkey'));
    render(<PatientStatusActions patient={{ ...base, status: 'ON_HOLD' }} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('patient-status-action-retomar'));
    const box = await screen.findByTestId('patient-status-action-error');
    expect(box).toHaveTextContent(t('admin.patients.status.error'));
    expect(box).not.toHaveTextContent('duplicate key');
    expect((es as any).admin.patients.status.error).toBeTruthy();
  });

  it('403 da lista (sem patient:update) → nada na tela; falha de leitura → aviso com "tentar de novo", nunca todas as ações', async () => {
    getPatientStatusActions.mockRejectedValueOnce(new PatientApiError('no', 403));
    const { container, unmount } = render(<PatientStatusActions patient={{ ...base, status: 'ACTIVE' }} onSaved={vi.fn()} />);
    await waitFor(() => expect(getPatientStatusActions).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    unmount();
    getPatientStatusActions.mockReset().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(lista('ACTIVE', [acao('suspender', 'SUSPENDED')]));
    render(<PatientStatusActions patient={{ ...base, status: 'ACTIVE' }} onSaved={vi.fn()} />);
    expect(await screen.findByTestId('patient-status-actions-error')).toBeInTheDocument();
    expect(screen.queryByTestId('patient-status-action-suspender')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('patient-status-actions-retry'));
    expect(await screen.findByTestId('patient-status-action-suspender')).toBeInTheDocument();
  });

  it('i18n: as 6 ações e o "Retomado" do Historial existem em es e pt-BR (sem chave só de um lado)', () => {
    for (const loc of [ptBR, es] as Array<Record<string, any>>) {
      const st = loc.admin.patients.status;
      for (const n of ['pausar', 'suspender', 'dar_alta', 'dar_baja', 'retomar', 'reativar']) expect(typeof st.actions.names[n]).toBe('string');
      for (const k of ['title', 'loadError', 'confirm', 'cancel', 'willBecome']) expect(typeof st.actions[k]).toBe('string');
      expect(st.sources.resume).toBe('Retomado');
    }
  });
});
