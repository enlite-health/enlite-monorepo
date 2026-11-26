/**
 * PatientStatusControl — F5 de estado-automatico-do-paciente: o select livre de estado SAIU. A ficha mostra o estado atual (só
 * leitura) e, ao lado, as AÇÕES dos estados humanos (`PatientStatusActions`, testadas em `PatientStatusActions.test.tsx`).
 *   - só aparece quando o paciente já passou pela admissão (admissionStatus DONE) — antes, o caminho é o foguete do serviço;
 *   - não há `<select>`, botão Guardar, nem leitura de lista de destinos: nada aqui escolhe Búsqueda, Reemplazo ou Activo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
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

const updatePatientStatus = vi.fn();
const getPatientStatusActions = vi.fn();
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    updatePatientStatus: (...a: unknown[]) => updatePatientStatus(...a),
    getPatientStatusActions: (...a: unknown[]) => getPatientStatusActions(...a),
    performPatientStatusAction: vi.fn(),
  },
}));

import { PatientStatusControl } from '../PatientStatusControl';

const active = { ...patientDetailFixture, status: 'ACTIVE', admissionStatus: 'DONE' as const, onHoldReason: null, onHoldNote: null };

describe('PatientStatusControl (só leitura + ações)', () => {
  beforeEach(() => {
    updatePatientStatus.mockReset();
    getPatientStatusActions.mockReset().mockResolvedValue({
      current: 'ACTIVE',
      actions: [{ acao: 'pausar', destino: 'ON_HOLD', via: 'fluxo', exige: ['onHoldReason'] }],
    });
  });

  it('não renderiza para paciente ainda no funil de admissão (o caminho é o foguete do serviço)', () => {
    const { container } = render(<PatientStatusControl patient={{ ...active, admissionStatus: 'ADMISSION' }} onSaved={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
    expect(getPatientStatusActions).not.toHaveBeenCalled();
  });

  it('mostra o estado atual traduzido e NENHUM select nem Guardar: o estado não se escolhe à mão', async () => {
    render(<PatientStatusControl patient={active} onSaved={vi.fn()} />);
    expect(screen.getByTestId('patient-status-current')).toHaveTextContent('Estado: Ativo');
    await screen.findByTestId('patient-status-action-pausar');
    expect(screen.queryByTestId('patient-status-select')).not.toBeInTheDocument();
    expect(screen.queryByTestId('patient-status-save')).not.toBeInTheDocument();
    expect(document.querySelector('select')).toBeNull();
    expect(updatePatientStatus).not.toHaveBeenCalled();
  });

  it('as ações da F3 continuam ao lado do estado: a lista vem do servidor (GET status-actions)', async () => {
    render(<PatientStatusControl patient={active} onSaved={vi.fn()} />);
    await waitFor(() => expect(getPatientStatusActions).toHaveBeenCalledWith(active.id));
    expect(await screen.findByTestId('patient-status-action-pausar')).toBeInTheDocument();
  });

  // Comportamento herdado: null cai em ACTIVE; funil e valor desconhecido mostram O VALOR (nunca "Ativo").
  it('estado do funil ou valor desconhecido NÃO vira "Ativo": o controle mostra o valor do paciente', () => {
    const { unmount } = render(<PatientStatusControl patient={{ ...active, status: 'NOVO_ESTADO' as never }} onSaved={vi.fn()} />);
    expect(screen.getByTestId('patient-status-current')).toHaveTextContent('Estado: NOVO_ESTADO');
    unmount();
    render(<PatientStatusControl patient={{ ...active, status: null as never }} onSaved={vi.fn()} />);
    expect(screen.getByTestId('patient-status-current')).toHaveTextContent('Estado: Ativo');
  });
});
