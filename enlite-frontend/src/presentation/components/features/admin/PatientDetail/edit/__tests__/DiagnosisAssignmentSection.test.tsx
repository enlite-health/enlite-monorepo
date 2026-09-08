/**
 * DiagnosisAssignmentSection — compõe busca + chips (spec 016 F3). Cada ação (escolher,
 * promover, remover) já é o "salvar": chama a API e, no sucesso, dispara `onChanged`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import { DiagnosisAssignmentSection } from '../DiagnosisAssignmentSection';
import type { PatientDiagnosisDetail } from '@domain/entities/PatientDetail';

const translations = ptBR as Record<string, any>;
function t(key: string, optsOrDefault?: any): string {
  let current: any = translations;
  for (const part of key.split('.')) current = current?.[part];
  if (typeof current === 'string') return current;
  if (typeof optsOrDefault === 'string') return optsOrDefault;
  return key;
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));

const search = vi.fn();
vi.mock('@infrastructure/http/AdminTerminologyApiService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@infrastructure/http/AdminTerminologyApiService')>();
  return {
    TerminologyUnavailableError: actual.TerminologyUnavailableError,
    AdminTerminologyApiService: { search: (...a: unknown[]) => search(...a) },
  };
});

const create = vi.fn();
const promote = vi.fn();
const deactivate = vi.fn();
vi.mock('@infrastructure/http/AdminDiagnosisApiService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@infrastructure/http/AdminDiagnosisApiService')>();
  return {
    DiagnosisApiError: actual.DiagnosisApiError,
    AdminDiagnosisApiService: {
      create: (...a: unknown[]) => create(...a),
      promote: (...a: unknown[]) => promote(...a),
      deactivate: (...a: unknown[]) => deactivate(...a),
    },
  };
});
import { DiagnosisApiError } from '@infrastructure/http/AdminDiagnosisApiService';

const PATIENT_ID = 'p1';

function diag(over: Partial<PatientDiagnosisDetail> = {}): PatientDiagnosisDetail {
  return { id: 'd1', uri: 'u1', title: 'Esquizofrenia', isPrimary: false, source: 'PANEL', active: true, ...over };
}

async function pickCandidate(title: string, uri = 'u-new') {
  search.mockResolvedValue([{ uri, title }]);
  const input = screen.getByTestId('icd-search-input');
  fireEvent.change(input, { target: { value: 'esquiso' } });
  await waitFor(() => expect(screen.getByTestId('icd-search-option-0')).toBeInTheDocument(), { timeout: 3000 });
  fireEvent.click(screen.getByTestId('icd-search-option-0'));
}

describe('DiagnosisAssignmentSection', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('seed inicial: só entram diagnósticos ATIVOS da origem PANEL (CLICKUP/BACKFILL e inativos ficam fora)', () => {
    render(
      <DiagnosisAssignmentSection
        patientId={PATIENT_ID}
        initialDiagnoses={[
          diag({ id: 'panel-ativo', source: 'PANEL', active: true, title: 'Panel Ativo' }),
          diag({ id: 'panel-inativo', source: 'PANEL', active: false, title: 'Panel Inativo' }),
          diag({ id: 'clickup', source: 'CLICKUP', active: true, title: 'Do ClickUp' }),
        ]}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByTestId('diagnosis-chip-panel-ativo')).toBeInTheDocument();
    expect(screen.queryByTestId('diagnosis-chip-panel-inativo')).not.toBeInTheDocument();
    expect(screen.queryByTestId('diagnosis-chip-clickup')).not.toBeInTheDocument();
  });

  it('escolher um candidato: POST via create, o chip aparece, onChanged dispara', async () => {
    create.mockResolvedValue(diag({ id: 'novo', title: 'Esquizofrenia', uri: 'u-new' }));
    const onChanged = vi.fn();
    render(<DiagnosisAssignmentSection patientId={PATIENT_ID} initialDiagnoses={[]} onChanged={onChanged} />);
    await pickCandidate('Esquizofrenia', 'u-new');
    expect(create).toHaveBeenCalledWith(PATIENT_ID, 'u-new');
    await waitFor(() => expect(screen.getByTestId('diagnosis-chip-novo')).toBeInTheDocument());
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  // 06/09 (Gabriel): "demora uns milissegundos para aparecer — precisamos de um aviso de carregando
  // para o usuário entender que NÃO TRAVOU". O POST fica pendurado numa Promise controlada: enquanto
  // não responde, o chip provisório "Adicionando…" está na tela e a busca fica desabilitada.
  it('enquanto o POST está em voo: chip provisório "Adicionando…" com o título; some quando a API responde', async () => {
    let resolveCreate!: (v: PatientDiagnosisDetail) => void;
    create.mockReturnValue(new Promise<PatientDiagnosisDetail>((res) => { resolveCreate = res; }));
    render(<DiagnosisAssignmentSection patientId={PATIENT_ID} initialDiagnoses={[]} onChanged={vi.fn()} />);
    await pickCandidate('Esquizofrenia', 'u-new');
    const pending = await screen.findByTestId('diagnosis-chip-pending');
    expect(pending).toHaveTextContent('Esquizofrenia');
    expect(pending).toHaveTextContent('Adicionando…');
    expect(screen.getByTestId('icd-search-input')).toBeDisabled();
    expect(screen.queryByTestId('diagnosis-chip-novo')).not.toBeInTheDocument();
    await act(async () => { resolveCreate(diag({ id: 'novo', title: 'Esquizofrenia', uri: 'u-new' })); });
    await waitFor(() => expect(screen.getByTestId('diagnosis-chip-novo')).toBeInTheDocument());
    expect(screen.queryByTestId('diagnosis-chip-pending')).not.toBeInTheDocument();
    expect(screen.getByTestId('icd-search-input')).not.toBeDisabled();
  });

  it('POST falha: o chip provisório some junto com a chegada do erro (não fica "Adicionando…" para sempre)', async () => {
    let rejectCreate!: (e: unknown) => void;
    create.mockReturnValue(new Promise<PatientDiagnosisDetail>((_r, rej) => { rejectCreate = rej; }));
    render(<DiagnosisAssignmentSection patientId={PATIENT_ID} initialDiagnoses={[]} onChanged={vi.fn()} />);
    await pickCandidate('Esquizofrenia', 'u-new');
    await screen.findByTestId('diagnosis-chip-pending');
    await act(async () => { rejectCreate(new DiagnosisApiError('nope', 422, 'CONCEPT_NOT_DIAGNOSABLE')); });
    await waitFor(() => expect(screen.getByTestId('diagnosis-assignment-error')).toBeInTheDocument());
    expect(screen.queryByTestId('diagnosis-chip-pending')).not.toBeInTheDocument();
  });

  // 06/09 (Gabriel): "quando deleto uma também precisa".
  it('enquanto o DELETE está em voo: o chip mostra "Removendo…" e esconde os botões; some quando responde', async () => {
    let resolveDeactivate!: (v: PatientDiagnosisDetail) => void;
    deactivate.mockReturnValue(new Promise<PatientDiagnosisDetail>((res) => { resolveDeactivate = res; }));
    render(<DiagnosisAssignmentSection patientId={PATIENT_ID} initialDiagnoses={[diag({ id: 'd1' })]} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByTestId('diagnosis-chip-remove-d1'));
    fireEvent.click(screen.getByTestId('diagnosis-chip-remove-confirm-btn-d1'));
    const busy = await screen.findByTestId('diagnosis-chip-busy-d1');
    expect(busy).toHaveTextContent('Removendo…');
    expect(screen.queryByTestId('diagnosis-chip-remove-d1')).not.toBeInTheDocument();
    await act(async () => { resolveDeactivate(diag({ id: 'd1', active: false })); });
    await waitFor(() => expect(screen.queryByTestId('diagnosis-chip-d1')).not.toBeInTheDocument());
  });

  it('enquanto o PATCH de promover está em voo: o chip mostra "Salvando…"', async () => {
    let resolvePromote!: (v: PatientDiagnosisDetail) => void;
    promote.mockReturnValue(new Promise<PatientDiagnosisDetail>((res) => { resolvePromote = res; }));
    render(<DiagnosisAssignmentSection patientId={PATIENT_ID} initialDiagnoses={[diag({ id: 'd1' })]} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByTestId('diagnosis-chip-promote-d1'));
    expect(await screen.findByTestId('diagnosis-chip-busy-d1')).toHaveTextContent('Salvando…');
    await act(async () => { resolvePromote(diag({ id: 'd1', isPrimary: true })); });
    await waitFor(() => expect(screen.getByTestId('diagnosis-chip-primary-badge-d1')).toBeInTheDocument());
    expect(screen.queryByTestId('diagnosis-chip-busy-d1')).not.toBeInTheDocument();
  });

  it('promover: PATCH via promote, o chip vira principal e os outros são rebaixados na tela', async () => {
    promote.mockResolvedValue(diag({ id: 'd2', isPrimary: true, title: 'B' }));
    const onChanged = vi.fn();
    render(
      <DiagnosisAssignmentSection
        patientId={PATIENT_ID}
        initialDiagnoses={[diag({ id: 'd1', isPrimary: true, title: 'A' }), diag({ id: 'd2', isPrimary: false, title: 'B' })]}
        onChanged={onChanged}
      />,
    );
    fireEvent.click(screen.getByTestId('diagnosis-chip-promote-d2'));
    expect(promote).toHaveBeenCalledWith(PATIENT_ID, 'd2');
    await waitFor(() => expect(screen.getByTestId('diagnosis-chip-primary-badge-d2')).toBeInTheDocument());
    expect(screen.queryByTestId('diagnosis-chip-primary-badge-d1')).not.toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('remover: PATCH via deactivate (após confirmar — U3), o chip some da lista, onChanged dispara', async () => {
    deactivate.mockResolvedValue(diag({ id: 'd1', active: false }));
    const onChanged = vi.fn();
    render(
      <DiagnosisAssignmentSection patientId={PATIENT_ID} initialDiagnoses={[diag({ id: 'd1' })]} onChanged={onChanged} />,
    );
    fireEvent.click(screen.getByTestId('diagnosis-chip-remove-d1'));
    expect(deactivate).not.toHaveBeenCalled(); // U3: só pede confirmação, ainda não remove
    fireEvent.click(screen.getByTestId('diagnosis-chip-remove-confirm-btn-d1'));
    expect(deactivate).toHaveBeenCalledWith(PATIENT_ID, 'd1');
    await waitFor(() => expect(screen.queryByTestId('diagnosis-chip-d1')).not.toBeInTheDocument());
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('erro conhecido (CONCEPT_NOT_DIAGNOSABLE) traduz a mensagem — não chama onChanged', async () => {
    create.mockRejectedValue(new DiagnosisApiError('nope', 422, 'CONCEPT_NOT_DIAGNOSABLE'));
    const onChanged = vi.fn();
    render(<DiagnosisAssignmentSection patientId={PATIENT_ID} initialDiagnoses={[]} onChanged={onChanged} />);
    await pickCandidate('Trastornos mentales (capítulo)', 'u-chapter');
    await waitFor(() => expect(screen.getByTestId('diagnosis-assignment-error')).toHaveTextContent(
      'Esse resultado não é um diagnóstico específico — escolha uma categoria mais concreta.',
    ));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('erro sem code conhecido cai no genérico', async () => {
    create.mockRejectedValue(new Error('boom'));
    render(<DiagnosisAssignmentSection patientId={PATIENT_ID} initialDiagnoses={[]} onChanged={vi.fn()} />);
    await pickCandidate('X', 'u-x');
    await waitFor(() => expect(screen.getByTestId('diagnosis-assignment-error')).toHaveTextContent(
      'Não foi possível concluir a ação. Tente novamente.',
    ));
  });

  it('erro ao promover mostra mensagem e não derruba a lista', async () => {
    promote.mockRejectedValue(new DiagnosisApiError('conflict', 409, 'PRIMARY_DIAGNOSIS_RACE'));
    render(
      <DiagnosisAssignmentSection patientId={PATIENT_ID} initialDiagnoses={[diag({ id: 'd1' })]} onChanged={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId('diagnosis-chip-promote-d1'));
    await waitFor(() => expect(screen.getByTestId('diagnosis-assignment-error')).toHaveTextContent(
      'Não foi possível atualizar o diagnóstico.',
    ));
    expect(screen.getByTestId('diagnosis-chip-d1')).toBeInTheDocument();
  });

  it('erro ao remover mostra mensagem e não remove o chip', async () => {
    deactivate.mockRejectedValue(new DiagnosisApiError('conflict', 409, 'DIAGNOSIS_NOT_ACTIVE'));
    render(
      <DiagnosisAssignmentSection patientId={PATIENT_ID} initialDiagnoses={[diag({ id: 'd1' })]} onChanged={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId('diagnosis-chip-remove-d1'));
    fireEvent.click(screen.getByTestId('diagnosis-chip-remove-confirm-btn-d1'));
    await waitFor(() => expect(screen.getByTestId('diagnosis-assignment-error')).toBeInTheDocument());
    expect(screen.getByTestId('diagnosis-chip-d1')).toBeInTheDocument();
  });

  it('cláusula 1.3 da OMS: a atribuição fica sempre visível', () => {
    render(<DiagnosisAssignmentSection patientId={PATIENT_ID} initialDiagnoses={[]} onChanged={vi.fn()} />);
    expect(screen.getByTestId('who-attribution')).toHaveTextContent('Organização Mundial da Saúde');
  });
});
