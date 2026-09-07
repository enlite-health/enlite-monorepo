/**
 * PatientStatusControl — spec 012, US-B7: o select de estado v2 na ficha, com motivo + nota
 * quando ON_HOLD, e a mensagem da transição proibida (422 com código de enum).
 *   - só aparece quando o paciente já passou pela admissão (admissionStatus DONE) — antes, o
 *     botão Activar é o caminho;
 *   - a nota é texto clínico restrito: `data-clarity-mask` no wrapper, teto 2000, desabilitada
 *     quando o backend a redigiu (onHoldNoteRedacted);
 *   - o PUT leva exatamente { status, onHoldReason, onHoldNote }; fora de ON_HOLD, sem motivo/nota.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: { updatePatientStatus: (...a: unknown[]) => updatePatientStatus(...a) },
}));

import { PatientApiError } from '@infrastructure/http/AdminPatientsApiService';
import { PatientStatusControl } from '../PatientStatusControl';

const active = { ...patientDetailFixture, status: 'ACTIVE', admissionStatus: 'DONE' as const, onHoldReason: null, onHoldNote: null };

describe('PatientStatusControl', () => {
  beforeEach(() => { updatePatientStatus.mockReset().mockResolvedValue({ id: active.id, status: 'ON_HOLD' }); });

  it('não renderiza para paciente ainda no funil de admissão (o caminho é Activar)', () => {
    const { container } = render(<PatientStatusControl patient={{ ...active, admissionStatus: 'ADMISSION' }} onSaved={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('mostra os 6 estados clínicos traduzidos com o atual selecionado; Guardar desabilitado sem mudança', () => {
    render(<PatientStatusControl patient={active} onSaved={vi.fn()} />);
    const select = screen.getByTestId('patient-status-select') as HTMLSelectElement;
    expect(select.value).toBe('ACTIVE');
    const values = [...select.options].map((o) => o.value).filter(Boolean); // o SelectField sempre emite a option de placeholder
    expect(values).toEqual(['ACTIVE', 'ON_HOLD', 'SEARCHING', 'REPLACEMENT', 'SUSPENDED', 'DISCHARGED']);
    expect([...select.options].map((o) => o.textContent)).toContain('Em espera');
    expect(screen.getByTestId('patient-status-save')).toBeDisabled();
    expect(screen.queryByTestId('patient-status-reason')).not.toBeInTheDocument();
  });

  it('ON_HOLD abre motivo + nota (mascarada, teto 2000); salva com os três e chama onSaved', async () => {
    const onSaved = vi.fn();
    render(<PatientStatusControl patient={active} onSaved={onSaved} />);
    fireEvent.change(screen.getByTestId('patient-status-select'), { target: { value: 'ON_HOLD' } });
    const reason = screen.getByTestId('patient-status-reason') as HTMLSelectElement;
    expect([...reason.options].map((o) => o.value)).toEqual(['', 'SCHOOL', 'INSURER', 'OTHER']);
    const note = screen.getByTestId('patient-status-note');
    expect(note.tagName).toBe('TEXTAREA');
    expect(note).toHaveAttribute('maxlength', '2000');
    expect(note.parentElement).toHaveAttribute('data-clarity-mask', 'True');
    // sem motivo, o botão fica travado (a regra é do servidor, mas a tela não manda lixo)
    expect(screen.getByTestId('patient-status-save')).toBeDisabled();
    fireEvent.change(reason, { target: { value: 'INSURER' } });
    fireEvent.change(note, { target: { value: 'Sin autorización de la obra social' } });
    fireEvent.click(screen.getByTestId('patient-status-save'));
    await waitFor(() => expect(updatePatientStatus).toHaveBeenCalledWith(active.id, {
      status: 'ON_HOLD', onHoldReason: 'INSURER', onHoldNote: 'Sin autorización de la obra social',
    }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('fora de ON_HOLD manda só o status; nota vazia vira null', async () => {
    render(<PatientStatusControl patient={active} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('patient-status-select'), { target: { value: 'SUSPENDED' } });
    fireEvent.click(screen.getByTestId('patient-status-save'));
    await waitFor(() => expect(updatePatientStatus).toHaveBeenCalledWith(active.id, { status: 'SUSPENDED' }));
    updatePatientStatus.mockClear();
    render(<PatientStatusControl patient={active} onSaved={vi.fn()} />);
    const selects = screen.getAllByTestId('patient-status-select');
    fireEvent.change(selects[1], { target: { value: 'ON_HOLD' } });
    fireEvent.change(screen.getByTestId('patient-status-reason'), { target: { value: 'OTHER' } });
    fireEvent.click(screen.getAllByTestId('patient-status-save')[1]);
    await waitFor(() => expect(updatePatientStatus).toHaveBeenCalledWith(active.id, { status: 'ON_HOLD', onHoldReason: 'OTHER', onHoldNote: null }));
  });

  it('422 de transição → mensagem traduzida com de→para; 422 de motivo → mensagem própria; outro erro → genérica', async () => {
    updatePatientStatus.mockRejectedValueOnce(new PatientApiError('nope', 422, { code: 'PATIENT_STATUS_TRANSITION_NOT_ALLOWED', details: { from: 'ACTIVE', to: 'SEARCHING' } }));
    render(<PatientStatusControl patient={active} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('patient-status-select'), { target: { value: 'SEARCHING' } });
    fireEvent.click(screen.getByTestId('patient-status-save'));
    await waitFor(() => expect(screen.getByTestId('patient-status-error')).toHaveTextContent('Transição não permitida: Ativo → Busca'));

    updatePatientStatus.mockRejectedValueOnce(new PatientApiError('nope', 422, { code: 'ON_HOLD_REASON_REQUIRED' }));
    fireEvent.click(screen.getByTestId('patient-status-save'));
    await waitFor(() => expect(screen.getByTestId('patient-status-error')).toHaveTextContent('Informe o motivo da espera'));

    updatePatientStatus.mockRejectedValueOnce(new Error('rede caiu'));
    fireEvent.click(screen.getByTestId('patient-status-save'));
    await waitFor(() => expect(screen.getByTestId('patient-status-error')).toHaveTextContent('rede caiu'));

    updatePatientStatus.mockRejectedValueOnce('x');
    fireEvent.click(screen.getByTestId('patient-status-save'));
    await waitFor(() => expect(screen.getByTestId('patient-status-error')).toHaveTextContent('Não foi possível mudar o estado'));
  });

  it('paciente em espera: motivo atual visível; nota redigida → textarea desabilitado e sem valor', () => {
    render(<PatientStatusControl patient={{ ...active, status: 'ON_HOLD', onHoldReason: 'SCHOOL', onHoldNote: null, onHoldNoteRedacted: true }} onSaved={vi.fn()} />);
    expect(screen.getByTestId('patient-status-reason')).toHaveValue('SCHOOL');
    expect(screen.getByTestId('patient-status-note')).toBeDisabled();
    expect(screen.getByTestId('patient-status-note')).toHaveValue('');
  });

  it('nota REDIGIDA: mudar só o motivo NÃO manda a chave onHoldNote (o servidor a trataria como apagamento)', async () => {
    render(<PatientStatusControl patient={{ ...active, status: 'ON_HOLD', onHoldReason: 'SCHOOL', onHoldNote: null, onHoldNoteRedacted: true }} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('patient-status-reason'), { target: { value: 'OTHER' } });
    fireEvent.click(screen.getByTestId('patient-status-save'));
    await waitFor(() => expect(updatePatientStatus).toHaveBeenCalledTimes(1));
    const payload = updatePatientStatus.mock.calls[0][1] as Record<string, unknown>;
    expect(payload).toEqual({ status: 'ON_HOLD', onHoldReason: 'OTHER' });
    expect(Object.prototype.hasOwnProperty.call(payload, 'onHoldNote')).toBe(false);
  });

  it('ramos: status null cai em ACTIVE; 422 sem details usa o atual/alvo; em espera, mudar só a nota já habilita', async () => {
    updatePatientStatus.mockRejectedValueOnce(new PatientApiError('nope', 422, { code: 'PATIENT_STATUS_TRANSITION_NOT_ALLOWED' }));
    render(<PatientStatusControl patient={{ ...active, status: null }} onSaved={vi.fn()} />);
    expect(screen.getByTestId('patient-status-select')).toHaveValue('ACTIVE');
    fireEvent.change(screen.getByTestId('patient-status-select'), { target: { value: 'DISCHARGED' } });
    fireEvent.click(screen.getByTestId('patient-status-save'));
    await waitFor(() => expect(screen.getByTestId('patient-status-error')).toHaveTextContent('Transição não permitida: Ativo → Baixa'));

    updatePatientStatus.mockClear();
    render(<PatientStatusControl patient={{ ...active, status: 'ON_HOLD', onHoldReason: 'SCHOOL', onHoldNote: 'antes' }} onSaved={vi.fn()} />);
    const saves = screen.getAllByTestId('patient-status-save');
    expect(saves.slice(-1)[0]).toBeDisabled();
    fireEvent.change(screen.getAllByTestId('patient-status-note').slice(-1)[0] as HTMLElement, { target: { value: 'depois' } });
    expect(saves.slice(-1)[0]).not.toBeDisabled();
    fireEvent.click(saves.slice(-1)[0] as HTMLElement);
    await waitFor(() => expect(updatePatientStatus).toHaveBeenCalledWith(active.id, { status: 'ON_HOLD', onHoldReason: 'SCHOOL', onHoldNote: 'depois' }));
  });

  it('em espera sem motivo gravado (legado): o select de motivo abre vazio e Guardar espera o motivo', () => {
    render(<PatientStatusControl patient={{ ...active, status: 'ON_HOLD', onHoldReason: null, onHoldNote: null }} onSaved={vi.fn()} />);
    expect(screen.getByTestId('patient-status-reason')).toHaveValue('');
    expect(screen.getByTestId('patient-status-save')).toBeDisabled();
    fireEvent.change(screen.getByTestId('patient-status-reason'), { target: { value: 'OTHER' } });
    expect(screen.getByTestId('patient-status-save')).not.toBeDisabled();
  });

  /* ── As duas travas de acessibilidade do controle v2 ──────────────────────────────────────────
     Por que existem: ao virar UMA linha, o controle perdeu o `<Label>` VISÍVEL e o `<select>`
     ficou transparente por cima da moldura. Os dois consertos (o `aria-label` que assume o nome
     acessível e o `focus-within` no ancestral) entraram sem NENHUMA asserção — apagar os dois
     deixava a suíte inteira verde, cobertura 100% intacta. Piso alto não vê atributo que ninguém
     lê: `SIZE`/`VARIANT` do `buttonClasses` já tinham ensinado isso na B4 do `3477d2e7`, e a
     instância vizinha ficou. */

  it('o select transparente carrega o nome acessível que o rótulo visível carregava', () => {
    render(<PatientStatusControl patient={active} onSaved={vi.fn()} />);
    // getByLabelText resolve o nome ACESSÍVEL (aria-label, <label for>, aria-labelledby) — mede o
    // que o leitor de tela anuncia, não a presença literal do atributo.
    expect(screen.getByLabelText(t('admin.patients.status.title'))).toBe(
      screen.getByTestId('patient-status-select'),
    );
  });

  it('o anel de foco vive num ANCESTRAL do elemento focável — o select é transparente e não o mostra', () => {
    render(<PatientStatusControl patient={active} onSaved={vi.fn()} />);
    const select = screen.getByTestId('patient-status-select');
    // O defeito que isto tranca: anel de foco numa div que NÃO é focável e sem `focus-within`.
    // A moldura só acende se o ancestral que a desenha reagir ao foco de dentro dele.
    const ring = select.closest('[class*="focus-within:ring"]');
    expect(ring).not.toBeNull();
    expect(ring).not.toBe(select);
    expect(ring!.className).toMatch(/focus-within:ring-2/);
    expect(ring!.className).toMatch(/focus-within:ring-primary/);
  });
});
