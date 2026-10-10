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
import { render, screen, fireEvent, waitFor, type RenderResult } from '@testing-library/react';
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
const getPatientStatusOptions = vi.fn();
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    updatePatientStatus: (...a: unknown[]) => updatePatientStatus(...a),
    getPatientStatusOptions: (...a: unknown[]) => getPatientStatusOptions(...a),
  },
}));

import { PatientApiError } from '@infrastructure/http/AdminPatientsApiService';
import { PatientStatusControl } from '../PatientStatusControl';

/** A lista que o SERVIDOR devolveria (spec 051): todos os outros clínicos, sem bloqueio. O controle filtra o atual. */
const ALL_STATUSES = ['ACTIVE', 'ON_HOLD', 'SEARCHING', 'REPLACEMENT', 'SUSPENDED', 'ALTA', 'DISCHARGED'];
const serverOptions = (statuses: string[], blocked: Record<string, string[]> = {}) => ({
  current: 'ACTIVE',
  options: statuses.map((status) => ({ status, via: 'fluxo' as const, ...(blocked[status] ? { blockedBy: blocked[status] } : {}) })),
});

/** Renderiza e espera a lista do servidor chegar (o select nasce travado). */
async function ready(ui: JSX.Element): Promise<RenderResult> {
  const r = render(ui);
  await waitFor(() => expect(screen.getAllByTestId('patient-status-select').slice(-1)[0]).not.toBeDisabled());
  return r;
}

const active = { ...patientDetailFixture, status: 'ACTIVE', admissionStatus: 'DONE' as const, onHoldReason: null, onHoldNote: null };

describe('PatientStatusControl', () => {
  beforeEach(() => {
    updatePatientStatus.mockReset().mockResolvedValue({ id: active.id, status: 'ON_HOLD' });
    getPatientStatusOptions.mockReset().mockResolvedValue(serverOptions(ALL_STATUSES));
  });

  it('não renderiza para paciente ainda no funil de admissão (o caminho é Activar)', async () => {
    const { container } = render(<PatientStatusControl patient={{ ...active, admissionStatus: 'ADMISSION' }} onSaved={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
    // e nem lê a lista do servidor: sem estado clínico ainda, não há o que oferecer
    expect(getPatientStatusOptions).not.toHaveBeenCalled();
  });

  it('mostra os 7 estados clínicos traduzidos (ALTA entrou na migration 498, D430) com o atual selecionado; Guardar desabilitado sem mudança', async () => {
    await ready(<PatientStatusControl patient={active} onSaved={vi.fn()} />);
    const select = screen.getByTestId('patient-status-select') as HTMLSelectElement;
    expect(select.value).toBe('ACTIVE');
    const values = [...select.options].map((o) => o.value).filter(Boolean); // o SelectField sempre emite a option de placeholder
    expect(values).toEqual(['ACTIVE', 'ON_HOLD', 'SEARCHING', 'REPLACEMENT', 'SUSPENDED', 'ALTA', 'DISCHARGED']);
    expect([...select.options].map((o) => o.textContent)).toContain('Em espera');
    expect(screen.getByTestId('patient-status-save')).toBeDisabled();
    expect(screen.queryByTestId('patient-status-reason')).not.toBeInTheDocument();
  });

  it('ON_HOLD abre motivo + nota (mascarada, teto 2000); salva com os três e chama onSaved', async () => {
    const onSaved = vi.fn();
    await ready(<PatientStatusControl patient={active} onSaved={onSaved} />);
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
    await ready(<PatientStatusControl patient={active} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('patient-status-select'), { target: { value: 'SUSPENDED' } });
    fireEvent.click(screen.getByTestId('patient-status-save'));
    await waitFor(() => expect(updatePatientStatus).toHaveBeenCalledWith(active.id, { status: 'SUSPENDED' }));
    updatePatientStatus.mockClear();
    await ready(<PatientStatusControl patient={active} onSaved={vi.fn()} />);
    const selects = screen.getAllByTestId('patient-status-select');
    fireEvent.change(selects[1], { target: { value: 'ON_HOLD' } });
    fireEvent.change(screen.getByTestId('patient-status-reason'), { target: { value: 'OTHER' } });
    fireEvent.click(screen.getAllByTestId('patient-status-save')[1]);
    await waitFor(() => expect(updatePatientStatus).toHaveBeenCalledWith(active.id, { status: 'ON_HOLD', onHoldReason: 'OTHER', onHoldNote: null }));
  });

  it('422 de transição → mensagem traduzida com de→para; 422 de motivo → mensagem própria; outro erro → genérica', async () => {
    updatePatientStatus.mockRejectedValueOnce(new PatientApiError('nope', 422, { code: 'PATIENT_STATUS_TRANSITION_NOT_ALLOWED', details: { from: 'ACTIVE', to: 'SEARCHING' } }));
    await ready(<PatientStatusControl patient={active} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('patient-status-select'), { target: { value: 'SEARCHING' } });
    fireEvent.click(screen.getByTestId('patient-status-save'));
    await waitFor(() => expect(screen.getByTestId('patient-status-error')).toHaveTextContent('Esta mudança de estado não está disponível.'));

    updatePatientStatus.mockRejectedValueOnce(new PatientApiError('nope', 422, { code: 'ON_HOLD_REASON_REQUIRED' }));
    fireEvent.click(screen.getByTestId('patient-status-save'));
    await waitFor(() => expect(screen.getByTestId('patient-status-error')).toHaveTextContent('Para deixar o paciente «Em espera», informe o motivo (escola, convênio ou outro).'));

    // Decisão do Gabriel 07/09: 422 de completude NOMEIA o que falta, com os rótulos do checklist.
    updatePatientStatus.mockRejectedValueOnce(
      new PatientApiError('nope', 422, {
        code: 'PATIENT_STATUS_NOT_READY',
        details: { to: 'SEARCHING', missing: ['SERVICE_SCHEDULE'] },
      }),
    );
    fireEvent.click(screen.getByTestId('patient-status-save'));
    await waitFor(() =>
      expect(screen.getByTestId('patient-status-error')).toHaveTextContent('o serviço contratado precisa estar completo. Falta: horário do serviço.'),
    );

    // 422 de completude SEM `details` — o servidor é a fonte, e o front não pode quebrar se o
    // corpo vier incompleto. Cai na frase GENÉRICA: com a interpolação vazia sairia
    // "Não é possível passar para Ativo: falta ." (achado do gate `revisao-pr`).
    updatePatientStatus.mockRejectedValueOnce(
      new PatientApiError('nope', 422, { code: 'PATIENT_STATUS_NOT_READY' }),
    );
    fireEvent.click(screen.getByTestId('patient-status-save'));
    await waitFor(() =>
      expect(screen.getByTestId('patient-status-error')).toHaveTextContent(
        'faltam dados obrigatórios na ficha',
      ),
    );
    expect(screen.getByTestId('patient-status-error').textContent).not.toMatch(/falta \.\s*$/);

    // `missing` que não é array (corpo estranho) recebe o mesmo tratamento — nunca crash
    updatePatientStatus.mockRejectedValueOnce(
      new PatientApiError('nope', 422, {
        code: 'PATIENT_STATUS_NOT_READY',
        details: { missing: 'SERVICE_SCHEDULE' },
      }),
    );
    fireEvent.click(screen.getByTestId('patient-status-save'));
    await waitFor(() =>
      expect(screen.getByTestId('patient-status-error')).toHaveTextContent(
        'faltam dados obrigatórios na ficha',
      ),
    );

    updatePatientStatus.mockRejectedValueOnce(new Error('rede caiu'));
    fireEvent.click(screen.getByTestId('patient-status-save'));
    await waitFor(() => expect(screen.getByTestId('patient-status-error')).toHaveTextContent('rede caiu'));

    updatePatientStatus.mockRejectedValueOnce('x');
    fireEvent.click(screen.getByTestId('patient-status-save'));
    await waitFor(() => expect(screen.getByTestId('patient-status-error')).toHaveTextContent('Não foi possível mudar o estado'));
  });

  it('paciente em espera: motivo atual visível; nota redigida → textarea desabilitado e sem valor', async () => {
    await ready(<PatientStatusControl patient={{ ...active, status: 'ON_HOLD', onHoldReason: 'SCHOOL', onHoldNote: null, onHoldNoteRedacted: true }} onSaved={vi.fn()} />);
    expect(screen.getByTestId('patient-status-reason')).toHaveValue('SCHOOL');
    expect(screen.getByTestId('patient-status-note')).toBeDisabled();
    expect(screen.getByTestId('patient-status-note')).toHaveValue('');
  });

  it('nota REDIGIDA: mudar só o motivo NÃO manda a chave onHoldNote (o servidor a trataria como apagamento)', async () => {
    await ready(<PatientStatusControl patient={{ ...active, status: 'ON_HOLD', onHoldReason: 'SCHOOL', onHoldNote: null, onHoldNoteRedacted: true }} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('patient-status-reason'), { target: { value: 'OTHER' } });
    fireEvent.click(screen.getByTestId('patient-status-save'));
    await waitFor(() => expect(updatePatientStatus).toHaveBeenCalledTimes(1));
    const payload = updatePatientStatus.mock.calls[0][1] as Record<string, unknown>;
    expect(payload).toEqual({ status: 'ON_HOLD', onHoldReason: 'OTHER' });
    expect(Object.prototype.hasOwnProperty.call(payload, 'onHoldNote')).toBe(false);
  });

  it('ramos: status null cai em ACTIVE; 422 sem details usa o atual/alvo; em espera, mudar só a nota já habilita', async () => {
    updatePatientStatus.mockRejectedValueOnce(new PatientApiError('nope', 422, { code: 'PATIENT_STATUS_TRANSITION_NOT_ALLOWED' }));
    await ready(<PatientStatusControl patient={{ ...active, status: null }} onSaved={vi.fn()} />);
    expect(screen.getByTestId('patient-status-select')).toHaveValue('ACTIVE');
    fireEvent.change(screen.getByTestId('patient-status-select'), { target: { value: 'DISCHARGED' } });
    fireEvent.click(screen.getByTestId('patient-status-save'));
    await waitFor(() => expect(screen.getByTestId('patient-status-error')).toHaveTextContent('Esta mudança de estado não está disponível.'));

    updatePatientStatus.mockClear();
    await ready(<PatientStatusControl patient={{ ...active, status: 'ON_HOLD', onHoldReason: 'SCHOOL', onHoldNote: 'antes' }} onSaved={vi.fn()} />);
    const saves = screen.getAllByTestId('patient-status-save');
    expect(saves.slice(-1)[0]).toBeDisabled();
    fireEvent.change(screen.getAllByTestId('patient-status-note').slice(-1)[0] as HTMLElement, { target: { value: 'depois' } });
    expect(saves.slice(-1)[0]).not.toBeDisabled();
    fireEvent.click(saves.slice(-1)[0] as HTMLElement);
    await waitFor(() => expect(updatePatientStatus).toHaveBeenCalledWith(active.id, { status: 'ON_HOLD', onHoldReason: 'SCHOOL', onHoldNote: 'depois' }));
  });

  it('em espera sem motivo gravado (legado): o select de motivo abre vazio e Guardar espera o motivo', async () => {
    await ready(<PatientStatusControl patient={{ ...active, status: 'ON_HOLD', onHoldReason: null, onHoldNote: null }} onSaved={vi.fn()} />);
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

  it('o select transparente carrega o nome acessível que o rótulo visível carregava', async () => {
    await ready(<PatientStatusControl patient={active} onSaved={vi.fn()} />);
    // getByLabelText resolve o nome ACESSÍVEL (aria-label, <label for>, aria-labelledby) — mede o
    // que o leitor de tela anuncia, não a presença literal do atributo.
    expect(screen.getByLabelText(t('admin.patients.status.title'))).toBe(
      screen.getByTestId('patient-status-select'),
    );
  });

  it('o anel de foco vive num ANCESTRAL do elemento focável — o select é transparente e não o mostra', async () => {
    await ready(<PatientStatusControl patient={active} onSaved={vi.fn()} />);
    const select = screen.getByTestId('patient-status-select');
    // O defeito que isto tranca: anel de foco numa div que NÃO é focável e sem `focus-within`.
    // A moldura só acende se o ancestral que a desenha reagir ao foco de dentro dele.
    const ring = select.closest('[class*="focus-within:ring"]');
    expect(ring).not.toBeNull();
    expect(ring).not.toBe(select);
    expect(ring!.className).toMatch(/focus-within:ring-2/);
    expect(ring!.className).toMatch(/focus-within:ring-primary/);
  });

  // ── Saída de SUSPENDED com motivo (decisão do Gabriel 29/09/2026, migration 486) ──────────────
  it('SUSPENDED → outro estado abre o select de motivo de saída (obrigatório); Guardar travado sem motivo; envia suspensionExitReason', async () => {
    const onSaved = vi.fn();
    await ready(<PatientStatusControl patient={{ ...active, status: 'SUSPENDED' }} onSaved={onSaved} />);
    fireEvent.change(screen.getByTestId('patient-status-select'), { target: { value: 'SEARCHING' } });
    const exitReason = screen.getByTestId('patient-status-exit-reason') as HTMLSelectElement;
    expect([...exitReason.options].map((o) => o.value)).toEqual(['', 'RESUMED_SERVICE', 'FAMILY_REQUESTED', 'NEEDS_NEW_WORKER', 'WRONG_STATUS', 'OTHER']);
    expect(screen.getByTestId('patient-status-save')).toBeDisabled();
    fireEvent.change(exitReason, { target: { value: 'RESUMED_SERVICE' } });
    expect(screen.getByTestId('patient-status-save')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('patient-status-save'));
    await waitFor(() => expect(updatePatientStatus).toHaveBeenCalledWith(active.id, { status: 'SEARCHING', suspensionExitReason: 'RESUMED_SERVICE' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('SUSPENDED sem sair (reenviar o mesmo estado) NÃO abre o select de motivo', async () => {
    await ready(<PatientStatusControl patient={{ ...active, status: 'SUSPENDED' }} onSaved={vi.fn()} />);
    expect(screen.queryByTestId('patient-status-exit-reason')).not.toBeInTheDocument();
  });

  it('422 SUSPENSION_EXIT_REASON_REQUIRED → mensagem própria', async () => {
    updatePatientStatus.mockRejectedValueOnce(new PatientApiError('nope', 422, { code: 'SUSPENSION_EXIT_REASON_REQUIRED' }));
    await ready(<PatientStatusControl patient={{ ...active, status: 'SUSPENDED' }} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('patient-status-select'), { target: { value: 'REPLACEMENT' } });
    fireEvent.change(screen.getByTestId('patient-status-exit-reason'), { target: { value: 'OTHER' } });
    fireEvent.click(screen.getByTestId('patient-status-save'));
    await waitFor(() => expect(screen.getByTestId('patient-status-error')).toHaveTextContent('Para tirar o paciente de «Suspenso», escolha o motivo.'));
  });
  // ── Spec 051: o select oferece SÓ o que o servidor devolve ───────────────────────────────────────
  it('não oferece o que a lista do servidor não traz (nenhum componente completa com o catálogo)', async () => {
    getPatientStatusOptions.mockResolvedValue(serverOptions(['ON_HOLD', 'DISCHARGED']));
    await ready(<PatientStatusControl patient={active} onSaved={vi.fn()} />);
    const values = [...(screen.getByTestId('patient-status-select') as HTMLSelectElement).options].map((o) => o.value);
    expect(values).toEqual(['ACTIVE', 'ON_HOLD', 'DISCHARGED']);
    expect(values).not.toContain('SEARCHING');
    expect(getPatientStatusOptions).toHaveBeenCalledWith(active.id);
  });

  it('destino com blockedBy aparece DESABILITADO com o motivo legível; o liberado segue habilitado', async () => {
    getPatientStatusOptions.mockResolvedValue(serverOptions(['SEARCHING', 'ON_HOLD'], { SEARCHING: ['SERVICE_SCHEDULE', 'SERVICE_ADDRESS'] }));
    await ready(<PatientStatusControl patient={active} onSaved={vi.fn()} />);
    const byValue = (v: string) => [...(screen.getByTestId('patient-status-select') as HTMLSelectElement).options].find((o) => o.value === v)!;
    expect(byValue('SEARCHING')).toBeDisabled();
    expect(byValue('SEARCHING').textContent).toBe('Busca (falta: horário do serviço, endereço do serviço)');
    expect(byValue('ON_HOLD')).not.toBeDisabled();
    expect(byValue('ON_HOLD').textContent).toBe('Em espera');
  });

  it('destino liberado por permissão (via) não leva marca nem aviso — é só mais uma opção', async () => {
    getPatientStatusOptions.mockResolvedValue({ current: 'ACTIVE', options: [{ status: 'SEARCHING', via: 'permissao' }] });
    await ready(<PatientStatusControl patient={active} onSaved={vi.fn()} />);
    const opt = [...(screen.getByTestId('patient-status-select') as HTMLSelectElement).options].find((o) => o.value === 'SEARCHING')!;
    expect(opt).not.toBeDisabled();
    expect(opt.textContent).toBe('Busca');
    expect(screen.queryByTestId('patient-status-error')).not.toBeInTheDocument();
    expect(screen.queryByTestId('patient-status-options-error')).not.toBeInTheDocument();
  });

  it('enquanto a lista carrega o select fica desabilitado e só mostra o atual', async () => {
    let resolve!: (v: unknown) => void;
    getPatientStatusOptions.mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<PatientStatusControl patient={active} onSaved={vi.fn()} />);
    const select = screen.getByTestId('patient-status-select') as HTMLSelectElement;
    expect(select).toBeDisabled();
    expect([...select.options].map((o) => o.value)).toEqual(['ACTIVE']);
    resolve(serverOptions(['ON_HOLD']));
    await waitFor(() => expect(select).not.toBeDisabled());
  });

  it('falha de leitura da lista: o select NÃO volta à lista inteira — trava, avisa e deixa tentar de novo', async () => {
    getPatientStatusOptions.mockRejectedValueOnce(new Error('rede caiu'));
    render(<PatientStatusControl patient={active} onSaved={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('patient-status-options-error')).toBeInTheDocument());
    const select = screen.getByTestId('patient-status-select') as HTMLSelectElement;
    expect(select).toBeDisabled();
    expect([...select.options].map((o) => o.value)).toEqual(['ACTIVE']);
    expect(screen.getByTestId('patient-status-options-error')).toHaveTextContent('Não foi possível carregar os estados disponíveis.');
    expect(screen.getByTestId('patient-status-save')).toBeDisabled();

    getPatientStatusOptions.mockResolvedValueOnce(serverOptions(['ON_HOLD']));
    fireEvent.click(screen.getByTestId('patient-status-options-retry'));
    await waitFor(() => expect(select).not.toBeDisabled());
    expect([...select.options].map((o) => o.value)).toEqual(['ACTIVE', 'ON_HOLD']);
    expect(screen.queryByTestId('patient-status-options-error')).not.toBeInTheDocument();
    expect(getPatientStatusOptions).toHaveBeenCalledTimes(2);
  });

  it('403 do PUT: frase amigável com o estado de destino, SEM código técnico, enum nem nome de célula; relê a lista', async () => {
    updatePatientStatus.mockRejectedValueOnce(new PatientApiError('Forbidden', 403, {
      code: 'PATIENT_STATUS_MOVE_NOT_PERMITTED',
      details: { from: 'ACTIVE', to: 'SEARCHING', cell: 'patient_status:move_to_searching' },
    }));
    await ready(<PatientStatusControl patient={active} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('patient-status-select'), { target: { value: 'SEARCHING' } });
    fireEvent.click(screen.getByTestId('patient-status-save'));
    const msg = await screen.findByTestId('patient-status-error');
    expect(msg).toHaveTextContent('Você não tem permissão para passar este paciente para «Busca». Peça a quem administra os acessos que habilite.');
    expect(msg.textContent).not.toMatch(/patient_status|move_to|PATIENT_STATUS|Forbidden|SEARCHING|ACTIVE|403/);
    await waitFor(() => expect(getPatientStatusOptions).toHaveBeenCalledTimes(2));
  });

  it('lista relida sem o destino que estava escolhido: a seleção volta ao estado atual (não salva o que o servidor já não oferece)', async () => {
    updatePatientStatus.mockRejectedValueOnce(new PatientApiError('Forbidden', 403, { code: 'PATIENT_STATUS_MOVE_NOT_PERMITTED', details: { to: 'SEARCHING' } }));
    await ready(<PatientStatusControl patient={active} onSaved={vi.fn()} />);
    getPatientStatusOptions.mockResolvedValue(serverOptions(['ON_HOLD']));
    fireEvent.change(screen.getByTestId('patient-status-select'), { target: { value: 'SEARCHING' } });
    fireEvent.click(screen.getByTestId('patient-status-save'));
    await waitFor(() => expect(screen.getByTestId('patient-status-select')).toHaveValue('ACTIVE'));
    expect(screen.getByTestId('patient-status-save')).toBeDisabled();
  });

  it('422 de completude em destino que não é SEARCHING usa "faltam dados do paciente" (o SEARCHING, coberto acima, fala do serviço contratado)', async () => {
    updatePatientStatus.mockRejectedValueOnce(new PatientApiError('nope', 422, { code: 'PATIENT_STATUS_NOT_READY', details: { to: 'ACTIVE', missing: ['ADDRESS'] } }));
    await ready(<PatientStatusControl patient={{ ...active, status: 'ON_HOLD', onHoldReason: 'SCHOOL', onHoldNote: null }} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('patient-status-select'), { target: { value: 'ACTIVE' } });
    fireEvent.click(screen.getByTestId('patient-status-save'));
    const msg = await screen.findByTestId('patient-status-error');
    expect(msg).toHaveTextContent(/^Para passar para «Ativo» faltam dados do paciente: domicílio\.$/);
  });
  it('estado do paciente mudou (ficha refeita): a lista do estado ANTERIOR não vale — trava até chegar a nova', async () => {
    const { rerender } = await ready(<PatientStatusControl patient={active} onSaved={vi.fn()} />);
    let resolve!: (v: unknown) => void;
    getPatientStatusOptions.mockReturnValue(new Promise((r) => { resolve = r; }));
    rerender(<PatientStatusControl patient={{ ...active, status: 'SEARCHING' }} onSaved={vi.fn()} />);
    const select = screen.getByTestId('patient-status-select') as HTMLSelectElement;
    expect(select).toBeDisabled();
    expect([...select.options].map((o) => o.value)).toEqual(['SEARCHING']);
    resolve({ current: 'SEARCHING', options: [{ status: 'ACTIVE', via: 'fluxo' }] });
    await waitFor(() => expect(select).not.toBeDisabled());
    expect([...select.options].map((o) => o.value)).toEqual(['SEARCHING', 'ACTIVE']);
  });
});
