/**
 * PatientDailyReportsTab — aba "Informes diarios" (spec 092, T501): lista, detalhe, redação do texto e estados de carga.
 * Dado 100% sintético; o texto-espião é `NARRATIVA-ESPIA-092`. A tela obedece ao servidor: `narrativeRedacted` mostra o aviso e NUNCA o texto.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import type { PatientDailyReport } from '@domain/entities/PatientDailyReport';

const translations = ptBR as Record<string, any>;
function t(key: string, opts?: Record<string, unknown> | string): string {
  let cur: any = translations;
  for (const p of key.split('.')) cur = cur?.[p];
  if (typeof cur !== 'string') return typeof opts === 'string' ? opts : key;
  return typeof opts === 'object' ? cur.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(opts[k])) : cur;
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));

const listForPatient = vi.fn();
vi.mock('@infrastructure/http/AdminDailyReportsApiService', () => {
  // Sem `importActual`: o módulo real instancia o `FirebaseAuthService` no carregamento (a suíte travava aqui).
  class DailyReportsApiError extends Error {
    readonly status: number;
    constructor(message: string, status: number) { super(message); this.status = status; }
  }
  return { DailyReportsApiError, AdminDailyReportsApiService: { listForPatient: (...a: unknown[]) => listForPatient(...a) } };
});

import { PatientDailyReportsTab } from '../PatientDailyReportsTab';
import { DailyReportsApiError } from '@infrastructure/http/AdminDailyReportsApiService';

const ESPIA = 'NARRATIVA-ESPIA-092';

function report(over: Partial<PatientDailyReport> = {}): PatientDailyReport {
  return {
    id: 'r1', workerId: '11111111-2222-3333-4444-555555556666', onDate: '2026-11-16', ptiVersionId: null, narrativeSource: 'TYPED',
    deviceSubmittedAt: '2026-11-17T12:00:00.000Z', receivedAt: '2026-11-17T12:05:00.000Z', appVersion: '1.0.0', late: false,
    answersCount: 2, immediateAlert: true,
    answers: [
      { itemKind: 'objective', itemId: 'o1', itemTitle: 'Objetivo sintético', scaleCode: 'GEN', optionCode: '1', countValue: null, reasonCode: null, score: 1, immediateAlert: true },
      { itemKind: 'activity', itemId: 'a1', itemTitle: 'Atividade sintética', scaleCode: 'AUT', optionCode: 'no_lo_hizo', countValue: null, reasonCode: 'cansado', score: null, immediateAlert: false },
      { itemKind: 'objective', itemId: 'o2', itemTitle: 'Contagem sintética', scaleCode: 'CNT', optionCode: null, countValue: 3, reasonCode: null, score: null, immediateAlert: false },
    ],
    narrative: null, narrativeRedacted: true,
    ...over,
  };
}

describe('PatientDailyReportsTab', () => {
  beforeEach(() => listForPatient.mockReset());
  afterEach(() => cleanup());

  it('carregando: mostra o indicador e pede a lista do paciente certo', () => {
    let release: (v: unknown) => void = () => {};
    listForPatient.mockReturnValueOnce(new Promise((r) => { release = r; }));
    render(<PatientDailyReportsTab patientId="p1" />);
    expect(screen.getByTestId('informes-diarios-loading')).toBeInTheDocument();
    expect(listForPatient).toHaveBeenCalledWith('p1');
    release({ items: [] });
  });

  it('lista: data, prestador (rótulo-padrão), nº de respostas, sinal e atraso; sem detalhe até clicar', async () => {
    listForPatient.mockResolvedValue({ items: [report(), report({ id: 'r2', immediateAlert: false, late: true, answersCount: 0, answers: [] })] });
    render(<PatientDailyReportsTab patientId="p1" />);
    const row1 = await screen.findByTestId('informe-diario-linha-r1');
    expect(row1).toHaveTextContent('16/11/26');
    expect(row1).toHaveTextContent('Prestador sem nome · 55556666');
    expect(screen.getByTestId('informe-diario-respuestas-r1')).toHaveTextContent('2');
    expect(screen.getByTestId('informe-diario-senal-r1')).toHaveTextContent('Aviso imediato');
    expect(screen.queryByTestId('informe-diario-atraso-r1')).not.toBeInTheDocument();
    expect(screen.getByTestId('informe-diario-senal-r2')).toHaveTextContent('—');
    expect(screen.getByTestId('informe-diario-atraso-r2')).toHaveTextContent('Fora do prazo');
    expect(screen.queryByTestId('informe-diario-detalle')).not.toBeInTheDocument();
  });

  it('detalhe SEM a célula do texto: respostas (opção, contagem, motivo, nota, sinal) e o aviso de texto oculto — o espião não existe na tela', async () => {
    listForPatient.mockResolvedValue({ items: [report()] });
    const { container } = render(<PatientDailyReportsTab patientId="p1" />);
    fireEvent.click(await screen.findByTestId('informe-diario-ver-r1'));
    const detail = screen.getByTestId('informe-diario-detalle');
    expect(detail).toHaveTextContent('Informe de 16/11/26 · Prestador sem nome · 55556666');
    expect(screen.getByTestId('informe-diario-aviso-inmediato')).toBeInTheDocument();
    const o1 = screen.getByTestId('informe-diario-respuesta-o1');
    expect(o1).toHaveTextContent('Objetivo');
    expect(o1).toHaveTextContent('Escala GEN');
    expect(o1).toHaveTextContent('Nota 1');
    expect(o1).toHaveTextContent('Aviso imediato');
    const a1 = screen.getByTestId('informe-diario-respuesta-a1');
    expect(a1).toHaveTextContent('Atividade');
    expect(a1).toHaveTextContent('no_lo_hizo');
    expect(a1).toHaveTextContent('Motivo: cansado');
    expect(a1).not.toHaveTextContent('Nota');
    expect(screen.getByTestId('informe-diario-respuesta-o2')).toHaveTextContent('3');
    expect(screen.getByTestId('informe-diario-texto-oculto')).toBeInTheDocument();
    expect(screen.queryByTestId('informe-diario-texto')).not.toBeInTheDocument();
    expect(container.textContent).not.toContain(ESPIA);
  });

  it('detalhe COM a célula do texto: o texto aparece (mascarado no replay) e o aviso de redação não', async () => {
    listForPatient.mockResolvedValue({ items: [report({ immediateAlert: false, narrative: `${ESPIA} relato sintético`, narrativeRedacted: false })] });
    render(<PatientDailyReportsTab patientId="p1" />);
    fireEvent.click(await screen.findByTestId('informe-diario-ver-r1'));
    const text = screen.getByTestId('informe-diario-texto');
    expect(text).toHaveTextContent(`${ESPIA} relato sintético`);
    expect(text.parentElement).toHaveAttribute('data-clarity-mask', 'True');
    expect(screen.queryByTestId('informe-diario-texto-oculto')).not.toBeInTheDocument();
    expect(screen.queryByTestId('informe-diario-aviso-inmediato')).not.toBeInTheDocument();
  });

  it('informe só com relato (sem respostas): avisa que não há respostas; trocar de informe troca o detalhe', async () => {
    listForPatient.mockResolvedValue({ items: [report({ id: 'r2', answers: [], answersCount: 0, immediateAlert: false }), report()] });
    render(<PatientDailyReportsTab patientId="p1" />);
    fireEvent.click(await screen.findByTestId('informe-diario-ver-r2'));
    expect(screen.getByTestId('informe-diario-sin-respuestas')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('informe-diario-ver-r1'));
    expect(screen.queryByTestId('informe-diario-sin-respuestas')).not.toBeInTheDocument();
    expect(screen.getByTestId('informe-diario-respuestas')).toBeInTheDocument();
  });

  it('data inválida cai no valor cru, sem quebrar', async () => {
    listForPatient.mockResolvedValue({ items: [report({ onDate: 'sem-data', receivedAt: 'sem-hora' })] });
    render(<PatientDailyReportsTab patientId="p1" />);
    const row = await screen.findByTestId('informe-diario-linha-r1');
    expect(row).toHaveTextContent('sem-data');
    expect(row).toHaveTextContent('sem-hora');
  });

  it('vazio: mensagem própria e nenhuma tabela', async () => {
    listForPatient.mockResolvedValue({ items: [] });
    render(<PatientDailyReportsTab patientId="p1" />);
    expect(await screen.findByTestId('informes-diarios-vazio')).toBeInTheDocument();
    expect(screen.queryByTestId('informes-diarios-lista')).not.toBeInTheDocument();
  });

  it('403: mostra "sem acesso", não "falhou"', async () => {
    listForPatient.mockRejectedValueOnce(new DailyReportsApiError('forbidden', 403));
    render(<PatientDailyReportsTab patientId="p1" />);
    expect(await screen.findByTestId('informes-diarios-forbidden')).toBeInTheDocument();
    expect(screen.queryByTestId('informes-diarios-error')).not.toBeInTheDocument();
  });

  it('erro qualquer (500 ou rede): mostra a falha de carga', async () => {
    listForPatient.mockRejectedValueOnce(new DailyReportsApiError('boom', 500)).mockRejectedValueOnce(new Error('rede'));
    const { unmount } = render(<PatientDailyReportsTab patientId="p1" />);
    expect(await screen.findByTestId('informes-diarios-error')).toBeInTheDocument();
    unmount();
    render(<PatientDailyReportsTab patientId="p2" />);
    await waitFor(() => expect(screen.getByTestId('informes-diarios-error')).toBeInTheDocument());
  });

  it('resposta que chega depois da troca de paciente não pinta a tela do novo', async () => {
    let resolveOld: (v: unknown) => void = () => {};
    listForPatient.mockReturnValueOnce(new Promise((r) => { resolveOld = r; }));
    listForPatient.mockResolvedValueOnce({ items: [] });
    const { rerender } = render(<PatientDailyReportsTab patientId="p-velho" />);
    rerender(<PatientDailyReportsTab patientId="p-novo" />);
    await screen.findByTestId('informes-diarios-vazio');
    resolveOld({ items: [report()] });
    await Promise.resolve();
    expect(screen.queryByTestId('informe-diario-linha-r1')).not.toBeInTheDocument();
  });
});
