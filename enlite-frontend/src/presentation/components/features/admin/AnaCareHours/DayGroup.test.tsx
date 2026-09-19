import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DayGroup } from './DayGroup';
import type { AnaCareProvider, AnaCareShift } from './types';
import type { DayGroupData } from './selectors';
import type { AxonicoComprobanteService, EnviarComprobanteAxonicoResult } from './AxonicoComprobanteService';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}|${JSON.stringify(opts)}` : key) }),
}));

function makeShift(overrides: Partial<AnaCareShift> = {}): AnaCareShift {
  return {
    id: 's1',
    date: '2026-08-14',
    // Item 2 (17/09): ISO com offset -06:00, forma real medida contra a API — não mais 'HH:MM'
    // já formatado (isso é responsabilidade da apresentação, `formatSourceRange`/`formatSourceTime`).
    scheduledStart: '2026-08-14T08:00:00-06:00',
    scheduledEnd: '2026-08-14T16:00:00-06:00',
    actualStart: '2026-08-14T08:00:00-06:00',
    actualEnd: '2026-08-14T16:00:00-06:00',
    hoursActual: 8,
    hoursScheduled: 8,
    origin: 'app',
    status: 'pendiente',
    anaCareShiftId: '90101',
    ...overrides,
  };
}

function makeProvider(overrides: Partial<AnaCareProvider> = {}): AnaCareProvider {
  return { anaCareId: 'p1', linked: true, name: 'Rocío García QA', shifts: [], ...overrides };
}

function makeDay(entries: DayGroupData['entries'], date = '2026-08-14'): DayGroupData {
  return { date, entries };
}

/** Turno "elegível" — validado, com par completo, 8h (hora cheia). Usado pra testar o botão HABILITADO. */
function eligibleShift(overrides: Partial<AnaCareShift> = {}): AnaCareShift {
  return makeShift({ status: 'validado', validatedBy: { id: 'e2e-qa', name: 'X' }, validatedAt: '2026-08-14T00:00:00Z', hoursActual: 8, ...overrides });
}

function makeAxonicoService(overrides: Partial<AxonicoComprobanteService> = {}): AxonicoComprobanteService {
  return { enviarComprobante: vi.fn(), ...overrides };
}

const noop = { onValidateShift: vi.fn(), onOpenContestModal: vi.fn(), onToggleShift: vi.fn(), onToggleDayPending: vi.fn() };
const DOC = '30111222';

describe('DayGroup', () => {
  it('POSITIVO — dia com 2 prestadores mostra o nome de cada um numa linha própria', () => {
    const providerA = makeProvider({ anaCareId: 'p1', name: 'Rocío García QA' });
    const providerB = makeProvider({ anaCareId: 'p2', name: 'Marta Sosa QA' });
    const day = makeDay([
      { shift: makeShift({ id: 's1' }), provider: providerA },
      { shift: makeShift({ id: 's2' }), provider: providerB },
    ]);
    render(<DayGroup day={day} disableActions={false} selectedShiftIds={new Set()} axonicoService={makeAxonicoService()} patientDocumentNumber={DOC} {...noop} />);
    expect(screen.getByTestId('anacare-hours-shift-row-s1')).toHaveTextContent('Rocío García QA');
    expect(screen.getByTestId('anacare-hours-shift-row-s2')).toHaveTextContent('Marta Sosa QA');
  });

  it('NEGATIVO — turno SEM check-in mostra "—" na coluna Horas (nunca 0.0 nem o previsto) e não soma no total do dia', () => {
    const providerA = makeProvider({ anaCareId: 'p1' });
    const day = makeDay([
      { shift: makeShift({ id: 's1', hoursActual: null, actualStart: null, actualEnd: null, hoursScheduled: 12, origin: 'sin_checkin' }), provider: providerA },
    ]);
    render(<DayGroup day={day} disableActions={false} selectedShiftIds={new Set()} axonicoService={makeAxonicoService()} patientDocumentNumber={DOC} {...noop} />);
    const row = screen.getByTestId('anacare-hours-shift-row-s1');
    expect(row).toHaveTextContent('—');
    expect(row).not.toHaveTextContent('12.0 h');
    expect(row).not.toHaveTextContent('0.0 h');
    expect(screen.getByText('admin.anacareHours.origin.scheduledNoActivity')).toBeInTheDocument();
    // Total do dia (cabeçalho) não soma o previsto do turno sem check-in — só o hoursActual (0 turnos com valor).
    expect(screen.getByTestId('anacare-hours-day-totals-2026-08-14')).toHaveTextContent(
      'admin.anacareHours.dayGroup.totalsSummary|{"total":"0.0","validated":"0.0"}',
    );
  });

  it('POSITIVO — cabeçalho do dia mostra total e horas validadas', () => {
    const providerA = makeProvider({ anaCareId: 'p1' });
    const day = makeDay([
      { shift: makeShift({ id: 's1', hoursActual: 8, status: 'validado', validatedBy: { id: 'e2e-qa', name: 'X' }, validatedAt: '2026-08-14T00:00:00Z' }), provider: providerA },
      { shift: makeShift({ id: 's2', hoursActual: 4, status: 'pendiente' }), provider: providerA },
    ]);
    render(<DayGroup day={day} disableActions={false} selectedShiftIds={new Set()} axonicoService={makeAxonicoService()} patientDocumentNumber={DOC} {...noop} />);
    expect(screen.getByTestId('anacare-hours-day-totals-2026-08-14')).toHaveTextContent(
      'admin.anacareHours.dayGroup.totalsSummary|{"total":"12.0","validated":"8.0"}',
    );
  });

  describe('botão "Enviar" — habilitação (axonicoDayEligibility)', () => {
    it('POSITIVO — HABILITADO só quando as 4 condições estão satisfeitas', () => {
      const providerA = makeProvider({ anaCareId: 'p1' });
      const day = makeDay([{ shift: eligibleShift({ id: 's1' }), provider: providerA }]);
      render(<DayGroup day={day} disableActions={false} selectedShiftIds={new Set()} axonicoService={makeAxonicoService()} patientDocumentNumber={DOC} {...noop} />);
      expect(screen.getByTestId('anacare-hours-send-day-2026-08-14')).not.toBeDisabled();
    });

    it('NEGATIVO — motivo notValidated: dia com turno pendente desabilita e mostra a explicação (testid próprio)', () => {
      const providerA = makeProvider({ anaCareId: 'p1' });
      const day = makeDay([{ shift: eligibleShift({ id: 's1' }) }, { shift: makeShift({ id: 's2', status: 'pendiente' }) }].map((e) => ({ ...e, provider: providerA })));
      render(<DayGroup day={day} disableActions={false} selectedShiftIds={new Set()} axonicoService={makeAxonicoService()} patientDocumentNumber={DOC} {...noop} />);
      expect(screen.getByTestId('anacare-hours-send-day-2026-08-14')).toBeDisabled();
      expect(screen.getByTestId('anacare-hours-axonico-reason-notValidated-2026-08-14')).toBeInTheDocument();
    });

    it('NEGATIVO — motivo missingCheckInOut: turno validado sem par completo desabilita e mostra a explicação', () => {
      const providerA = makeProvider({ anaCareId: 'p1' });
      const day = makeDay([{ shift: eligibleShift({ id: 's1', hoursActual: null, actualStart: null, actualEnd: null }), provider: providerA }]);
      render(<DayGroup day={day} disableActions={false} selectedShiftIds={new Set()} axonicoService={makeAxonicoService()} patientDocumentNumber={DOC} {...noop} />);
      expect(screen.getByTestId('anacare-hours-send-day-2026-08-14')).toBeDisabled();
      expect(screen.getByTestId('anacare-hours-axonico-reason-missingCheckInOut-2026-08-14')).toBeInTheDocument();
    });

    it('NEGATIVO — motivo fractionalHours: total do dia não é hora cheia desabilita e mostra a explicação (nunca arredonda)', () => {
      const providerA = makeProvider({ anaCareId: 'p1' });
      const day = makeDay([{ shift: eligibleShift({ id: 's1', hoursActual: 8.5 }), provider: providerA }]);
      render(<DayGroup day={day} disableActions={false} selectedShiftIds={new Set()} axonicoService={makeAxonicoService()} patientDocumentNumber={DOC} {...noop} />);
      expect(screen.getByTestId('anacare-hours-send-day-2026-08-14')).toBeDisabled();
      expect(screen.getByTestId('anacare-hours-axonico-reason-fractionalHours-2026-08-14')).toBeInTheDocument();
    });

    it('NEGATIVO — motivo missingDocument: paciente sem documentNumber desabilita e mostra a explicação', () => {
      const providerA = makeProvider({ anaCareId: 'p1' });
      const day = makeDay([{ shift: eligibleShift({ id: 's1' }), provider: providerA }]);
      render(<DayGroup day={day} disableActions={false} selectedShiftIds={new Set()} axonicoService={makeAxonicoService()} {...noop} />);
      expect(screen.getByTestId('anacare-hours-send-day-2026-08-14')).toBeDisabled();
      expect(screen.getByTestId('anacare-hours-axonico-reason-missingDocument-2026-08-14')).toBeInTheDocument();
    });

    it('NEGATIVO — disableActions (retrato desatualizado/gate) desabilita mesmo com o dia elegível, e NÃO duplica a explicação por motivo', () => {
      const providerA = makeProvider({ anaCareId: 'p1' });
      const day = makeDay([{ shift: eligibleShift({ id: 's1' }), provider: providerA }]);
      render(
        <DayGroup day={day} disableActions disableReason="retrato desactualizado" selectedShiftIds={new Set()} axonicoService={makeAxonicoService()} patientDocumentNumber={DOC} {...noop} />,
      );
      expect(screen.getByTestId('anacare-hours-send-day-2026-08-14')).toBeDisabled();
      expect(screen.getByTestId('anacare-hours-disable-reason-day-2026-08-14')).toHaveTextContent('admin.anacareHours.stale.blockedPrefix');
      expect(screen.queryByTestId('anacare-hours-axonico-reason-notValidated-2026-08-14')).not.toBeInTheDocument();
    });
  });

  describe('clique em "Enviar" — POST e estados', () => {
    it('POSITIVO — clique manda o comando EXATO ao serviço (documentNumber/documentType/serviceDate/hours)', async () => {
      const enviarComprobante = vi.fn<[], Promise<EnviarComprobanteAxonicoResult>>().mockResolvedValue({ status: 'enviado', numeroComprobante: 'C-1', codAutorizacion: 'A-1' });
      const providerA = makeProvider({ anaCareId: 'p1' });
      const day = makeDay([{ shift: eligibleShift({ id: 's1' }), provider: providerA }]);
      render(
        <DayGroup
          day={day}
          disableActions={false}
          selectedShiftIds={new Set()}
          axonicoService={makeAxonicoService({ enviarComprobante })}
          patientDocumentNumber={DOC}
          patientDocumentType="DNI"
          {...noop}
        />,
      );
      fireEvent.click(screen.getByTestId('anacare-hours-send-day-2026-08-14'));
      expect(enviarComprobante).toHaveBeenCalledWith({ documentNumber: DOC, documentType: 'DNI', serviceDate: '2026-08-14', hours: 8 });
      await waitFor(() => expect(screen.getByTestId('anacare-hours-day-sent-2026-08-14')).toBeInTheDocument());
    });

    it('POSITIVO — resposta "enviado" mostra o número do comprovante', async () => {
      const enviarComprobante = vi.fn().mockResolvedValue({ status: 'enviado', numeroComprobante: 'C-777', codAutorizacion: 'A-1' });
      const providerA = makeProvider({ anaCareId: 'p1' });
      const day = makeDay([{ shift: eligibleShift({ id: 's1' }), provider: providerA }]);
      render(<DayGroup day={day} disableActions={false} selectedShiftIds={new Set()} axonicoService={makeAxonicoService({ enviarComprobante })} patientDocumentNumber={DOC} {...noop} />);
      fireEvent.click(screen.getByTestId('anacare-hours-send-day-2026-08-14'));
      await waitFor(() => expect(screen.getByTestId('anacare-hours-day-sent-2026-08-14')).toHaveTextContent('C-777'));
    });

    it('POSITIVO — resposta "duplicado" diz que já foi faturado, mostra o comprovante ORIGINAL, e NÃO se apresenta como envio novo', async () => {
      const enviarComprobante = vi.fn().mockResolvedValue({ status: 'duplicado', numeroComprobante: 'C-ORIGINAL', codAutorizacion: 'A-ORIGINAL', jaFaturado: true });
      const providerA = makeProvider({ anaCareId: 'p1' });
      const day = makeDay([{ shift: eligibleShift({ id: 's1' }), provider: providerA }]);
      render(<DayGroup day={day} disableActions={false} selectedShiftIds={new Set()} axonicoService={makeAxonicoService({ enviarComprobante })} patientDocumentNumber={DOC} {...noop} />);
      fireEvent.click(screen.getByTestId('anacare-hours-send-day-2026-08-14'));
      await waitFor(() => expect(screen.getByTestId('anacare-hours-day-duplicated-2026-08-14')).toHaveTextContent('C-ORIGINAL'));
      expect(screen.queryByTestId('anacare-hours-day-sent-2026-08-14')).not.toBeInTheDocument();
    });

    it('POSITIVO — resposta "duplicado" do DEDUPE REMOTO (numeroComprobante null) diz que já foi faturado, sem imprimir "null"/"undefined" no DOM', async () => {
      const enviarComprobante = vi.fn().mockResolvedValue({ status: 'duplicado', numeroComprobante: null, codAutorizacion: null, jaFaturado: true, lancadoEm: '2026-09-18T12:00:00Z' });
      const providerA = makeProvider({ anaCareId: 'p1' });
      const day = makeDay([{ shift: eligibleShift({ id: 's1' }), provider: providerA }]);
      render(<DayGroup day={day} disableActions={false} selectedShiftIds={new Set()} axonicoService={makeAxonicoService({ enviarComprobante })} patientDocumentNumber={DOC} {...noop} />);
      fireEvent.click(screen.getByTestId('anacare-hours-send-day-2026-08-14'));
      const label = await screen.findByTestId('anacare-hours-day-duplicated-no-comprobante-2026-08-14');
      expect(label).toHaveTextContent('admin.anacareHours.dayGroup.axonico.duplicatedNoComprobanteLabel');
      expect(label.textContent).not.toMatch(/null|undefined/);
      expect(screen.queryByTestId('anacare-hours-day-duplicated-2026-08-14')).not.toBeInTheDocument();
      expect(screen.queryByTestId('anacare-hours-day-sent-2026-08-14')).not.toBeInTheDocument();
    });

    it('NEGATIVO — erro mostra a mensagem devolvida pelo serviço, e o botão volta a permitir tentar', async () => {
      const enviarComprobante = vi.fn().mockRejectedValue(new Error('Ya fue facturado con otro monto.'));
      const providerA = makeProvider({ anaCareId: 'p1' });
      const day = makeDay([{ shift: eligibleShift({ id: 's1' }), provider: providerA }]);
      render(<DayGroup day={day} disableActions={false} selectedShiftIds={new Set()} axonicoService={makeAxonicoService({ enviarComprobante })} patientDocumentNumber={DOC} {...noop} />);
      fireEvent.click(screen.getByTestId('anacare-hours-send-day-2026-08-14'));
      await waitFor(() => expect(screen.getByTestId('anacare-hours-day-send-error-2026-08-14')).toHaveTextContent('Ya fue facturado con otro monto.'));
      expect(screen.getByTestId('anacare-hours-send-day-2026-08-14')).not.toBeDisabled();
    });

    /**
     * Clique duplo: prova de NÍVEL DE COMPONENTE (a prova AUTORITATIVA — que sobrevive à
     * sabotagem do guard — está em `useSendComprobanteToAxonico.test.ts`, chamando `send()` duas
     * vezes de volta a volta ANTES de qualquer `await`; ver o comentário lá sobre por que um
     * teste só de UI corre o risco do `Button.tsx:46` mascarar a ausência da trava).
     */
    it('POSITIVO — dois cliques (fireEvent.click duas vezes) resultam em UM único POST', async () => {
      const enviarComprobante = vi.fn().mockResolvedValue({ status: 'enviado', numeroComprobante: 'C-1', codAutorizacion: 'A-1' });
      const providerA = makeProvider({ anaCareId: 'p1' });
      const day = makeDay([{ shift: eligibleShift({ id: 's1' }), provider: providerA }]);
      render(<DayGroup day={day} disableActions={false} selectedShiftIds={new Set()} axonicoService={makeAxonicoService({ enviarComprobante })} patientDocumentNumber={DOC} {...noop} />);
      const button = screen.getByTestId('anacare-hours-send-day-2026-08-14');
      fireEvent.click(button);
      fireEvent.click(button);
      await waitFor(() => expect(screen.getByTestId('anacare-hours-day-sent-2026-08-14')).toBeInTheDocument());
      expect(enviarComprobante).toHaveBeenCalledTimes(1);
    });
  });

  it('POSITIVO — checkbox de cabeçalho marca/desmarca todos os pendentes do dia (contestado fica de fora)', () => {
    const onToggleDayPending = vi.fn();
    const providerA = makeProvider({ anaCareId: 'p1' });
    const day = makeDay([
      { shift: makeShift({ id: 's1', status: 'pendiente' }), provider: providerA },
      { shift: makeShift({ id: 's2', status: 'contestado', contestReason: 'otro' }), provider: providerA },
    ]);
    render(
      <DayGroup day={day} disableActions={false} selectedShiftIds={new Set()} axonicoService={makeAxonicoService()} patientDocumentNumber={DOC} {...noop} onToggleDayPending={onToggleDayPending} />,
    );
    fireEvent.click(screen.getByTestId('anacare-hours-select-all-pending-day-2026-08-14'));
    expect(onToggleDayPending).toHaveBeenCalledWith([day.entries[0].shift, day.entries[1].shift]);
  });

  /**
   * Cobertura (17/09): `pendingSelectionStateOf` tem 3 ramos (`none`/`partial`/`all`) — só `none`
   * (nenhum selecionado) estava exercitado. Comportamento real: o checkbox de cabeçalho fica
   * MARCADO só quando TODOS os pendentes do dia estão selecionados — selecionar só 1 de 2 não pode
   * marcar o cabeçalho como "tudo selecionado" (o operador enviaria em lote sem querer).
   */
  it('POSITIVO — checkbox de cabeçalho fica MARCADO quando TODOS os pendentes do dia estão selecionados', () => {
    const providerA = makeProvider({ anaCareId: 'p1' });
    const day = makeDay([
      { shift: makeShift({ id: 's1', status: 'pendiente' }), provider: providerA },
      { shift: makeShift({ id: 's2', status: 'pendiente' }), provider: providerA },
    ]);
    render(
      <DayGroup day={day} disableActions={false} selectedShiftIds={new Set(['s1', 's2'])} axonicoService={makeAxonicoService()} patientDocumentNumber={DOC} {...noop} />,
    );
    const checkbox = screen.getByTestId('anacare-hours-select-all-pending-day-2026-08-14');
    expect(checkbox).toBeChecked();
    expect(checkbox).toHaveAttribute('data-selection-state', 'all');
  });

  it('NEGATIVO — checkbox de cabeçalho fica DESMARCADO quando só PARTE dos pendentes do dia está selecionada', () => {
    const providerA = makeProvider({ anaCareId: 'p1' });
    const day = makeDay([
      { shift: makeShift({ id: 's1', status: 'pendiente' }), provider: providerA },
      { shift: makeShift({ id: 's2', status: 'pendiente' }), provider: providerA },
    ]);
    render(<DayGroup day={day} disableActions={false} selectedShiftIds={new Set(['s1'])} axonicoService={makeAxonicoService()} patientDocumentNumber={DOC} {...noop} />);
    const checkbox = screen.getByTestId('anacare-hours-select-all-pending-day-2026-08-14');
    expect(checkbox).not.toBeChecked();
    expect(checkbox).toHaveAttribute('data-selection-state', 'partial');
  });

  /**
   * Cobertura (17/09): turno validado sem `validatedAt` (dado legado/incompleto do backend) —
   * o rótulo "validado por" tem de continuar mostrando UMA data ao operador (a do turno), em vez
   * de quebrar ou mostrar "Invalid Date". Comportamento real, não cobertura por cobertura.
   */
  it('POSITIVO — turno validado sem `validatedAt` mostra a data do TURNO no rótulo "validado por" (nunca quebra)', () => {
    const providerA = makeProvider({ anaCareId: 'p1' });
    const day = makeDay([
      { shift: makeShift({ id: 's1', date: '2026-08-14', status: 'validado', validatedBy: { id: 'e2e-qa', name: 'X' }, validatedAt: undefined }), provider: providerA },
    ]);
    render(<DayGroup day={day} disableActions={false} selectedShiftIds={new Set()} axonicoService={makeAxonicoService()} patientDocumentNumber={DOC} {...noop} />);
    const row = screen.getByTestId('anacare-hours-shift-row-s1');
    expect(row).toHaveTextContent('admin.anacareHours.providerGroup.validatedBy');
    expect(row).toHaveTextContent('"date":"14/08"');
  });

  it('POSITIVO — prestador sem vínculo mostra "Sin vínculo · ID <anaCareId>"', () => {
    const provider = makeProvider({ anaCareId: '90231', linked: false, name: undefined });
    const day = makeDay([{ shift: makeShift({ id: 's1' }), provider }]);
    render(<DayGroup day={day} disableActions={false} selectedShiftIds={new Set()} axonicoService={makeAxonicoService()} patientDocumentNumber={DOC} {...noop} />);
    expect(screen.getByTestId('anacare-hours-shift-row-s1')).toHaveTextContent('Sin vínculo · ID 90231');
  });

  /**
   * Item 2 (17/09): antes, a coluna Previsto/Check-in/Check-out mostrava o ISO cru
   * (`2026-08-01T20:00:00-06:00–...`), ilegível — medido no print da stage. Agora mostra `HH:MM`,
   * no fuso FIXO da fonte (`-06:00`), nunca convertido pro fuso do navegador.
   */
  it('POSITIVO — turno normal mostra Previsto/Check-in/Check-out em HH:MM, não o ISO cru', () => {
    const provider = makeProvider();
    const shift = makeShift({
      id: 's1',
      scheduledStart: '2026-08-14T08:00:00-06:00',
      scheduledEnd: '2026-08-14T16:00:00-06:00',
      actualStart: '2026-08-14T08:05:00-06:00',
      actualEnd: '2026-08-14T16:10:00-06:00',
    });
    const day = makeDay([{ shift, provider }]);
    render(<DayGroup day={day} disableActions={false} selectedShiftIds={new Set()} axonicoService={makeAxonicoService()} patientDocumentNumber={DOC} {...noop} />);
    const row = screen.getByTestId('anacare-hours-shift-row-s1');
    expect(row).toHaveTextContent('08:00–16:00');
    expect(screen.getByTestId('anacare-hours-shift-checkin-s1')).toHaveTextContent('08:05');
    expect(screen.getByTestId('anacare-hours-shift-checkout-s1')).toHaveTextContent('16:10');
    expect(row).not.toHaveTextContent('2026-08-14T08:00:00-06:00');
  });

  /** Caso medido de verdade (17/09): 46% dos turnos de agosto cruzam a meia-noite. */
  it('POSITIVO — turno NOTURNO que cruza a meia-noite mostra a marca do dia seguinte na coluna Previsto', () => {
    const provider = makeProvider();
    const shift = makeShift({
      id: 's1',
      scheduledStart: '2026-08-01T20:00:00-06:00',
      scheduledEnd: '2026-08-02T08:00:00-06:00',
      actualStart: '2026-08-01T20:12:00-06:00',
      actualEnd: '2026-08-02T08:00:00-06:00',
    });
    const day = makeDay([{ shift, provider }], '2026-08-01');
    render(<DayGroup day={day} disableActions={false} selectedShiftIds={new Set()} axonicoService={makeAxonicoService()} patientDocumentNumber={DOC} {...noop} />);
    const row = screen.getByTestId('anacare-hours-shift-row-s1');
    expect(row).toHaveTextContent('20:00–08:00 (+1)');
    expect(screen.getByTestId('anacare-hours-shift-checkin-s1')).toHaveTextContent('20:12');
    expect(screen.getByTestId('anacare-hours-shift-checkout-s1')).toHaveTextContent('08:00');
  });

  it('NEGATIVO — turno sem check-in mostra "—" em Check-in/Check-out, nunca ISO ou horário inventado', () => {
    const provider = makeProvider();
    const shift = makeShift({ id: 's1', actualStart: null, actualEnd: null, hoursActual: null, origin: 'sin_checkin' });
    const day = makeDay([{ shift, provider }]);
    render(<DayGroup day={day} disableActions={false} selectedShiftIds={new Set()} axonicoService={makeAxonicoService()} patientDocumentNumber={DOC} {...noop} />);
    expect(screen.getByTestId('anacare-hours-shift-checkin-s1')).toHaveTextContent('—');
    expect(screen.getByTestId('anacare-hours-shift-checkout-s1')).toHaveTextContent('—');
  });
});
