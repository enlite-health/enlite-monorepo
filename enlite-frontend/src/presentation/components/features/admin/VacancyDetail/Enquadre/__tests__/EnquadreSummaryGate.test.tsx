/**
 * Selo e botão do resumo do evento de enquadre (spec 052, Fase 3, T-36d): só existem quando a API MANDA o campo `summary` (quinta
 * célula, `enquadre_summary:read`). Sem o campo a tela não mostra o selo do resumo nem o botão — e o resto da esteira segue. O botão
 * pede a URL assinada a cada clique e a abre em aba nova. Sabotagem: mostrar o botão/selo sem checar `summary` deixa os testes
 * "sem o campo" vermelhos.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from '@infrastructure/i18n/config';
import type { EnquadrePipelineState } from '@domain/entities/EnquadreEvent';
import { AdminEnquadreSummaryApiService } from '@infrastructure/http/AdminEnquadreSummaryApiService';
import { EnquadrePipelineSeals } from '../EnquadrePipelineSeals';

vi.mock('@infrastructure/http/AdminEnquadreSummaryApiService', () => ({
  AdminEnquadreSummaryApiService: { getSummaryUrl: vi.fn() },
}));
const getSummaryUrl = vi.mocked(AdminEnquadreSummaryApiService.getSummaryUrl);

const done: EnquadrePipelineState = { importStatus: 'done', summary: 'ready', blockedReason: null, unidentifiedCount: 0 };
const semCelula = (p: EnquadrePipelineState): EnquadrePipelineState => {
  const { summary: _omitido, ...resto } = p; // o servidor NÃO manda a chave
  return resto;
};
const mount = (pipeline: EnquadrePipelineState) => render(<EnquadrePipelineSeals vacancyId="v1" eventId="ev-1" pipeline={pipeline} />);

beforeAll(async () => { await i18n.changeLanguage('es'); });
beforeEach(() => { getSummaryUrl.mockReset(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('selo e botão do resumo', () => {
  it('COM o campo: o selo "Resumen listo" e o botão de baixar aparecem', () => {
    mount(done);
    expect(screen.getByTestId('enquadre-seal-summary-chip-ev-1').textContent).toBe('Resumen listo');
    expect(screen.getByTestId('enquadre-summary-download-ev-1').textContent).toBe('Descargar resumen');
  });

  it('SEM o campo (sem a célula): nem o selo nem o botão — o selo da importação segue', () => {
    mount(semCelula(done));
    expect(screen.queryByTestId('enquadre-seal-summary-chip-ev-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('enquadre-summary-download-ev-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('enquadre-seal-import-chip-ev-1').textContent).toBe('Importada');
  });

  it('o botão só existe com o resumo pronto: esperando ou indisponível mostram o selo, sem botão', () => {
    mount({ ...done, summary: 'waiting' });
    expect(screen.getByTestId('enquadre-seal-summary-chip-ev-1')).toBeInTheDocument();
    expect(screen.queryByTestId('enquadre-summary-download-ev-1')).not.toBeInTheDocument();
    cleanup();
    mount({ ...done, summary: 'unavailable' });
    expect(screen.getByTestId('enquadre-seal-summary-chip-ev-1').textContent).toBe('Resumen no disponible');
    expect(screen.queryByTestId('enquadre-summary-download-ev-1')).not.toBeInTheDocument();
  });

  it('clicar pede a URL assinada DESTE evento a cada clique e a abre em aba nova (sem opener)', async () => {
    const popup = { opener: 'x' as unknown, closed: false, close: vi.fn(), location: { href: '' } };
    vi.stubGlobal('open', vi.fn().mockReturnValue(popup));
    getSummaryUrl.mockResolvedValue({ url: 'https://signed.example/resumo', expiresInSeconds: 300 });
    mount(done);
    await userEvent.click(screen.getByTestId('enquadre-summary-download-ev-1'));
    await userEvent.click(screen.getByTestId('enquadre-summary-download-ev-1'));
    await waitFor(() => expect(getSummaryUrl).toHaveBeenCalledTimes(2));
    expect(getSummaryUrl).toHaveBeenCalledWith('v1', 'ev-1');
    expect(window.open).toHaveBeenCalledWith('', '_blank');
    expect(popup.location.href).toBe('https://signed.example/resumo');
    expect(popup.opener).toBeNull();
  });

  it('falha ao pedir a URL: fecha a aba e avisa na linha', async () => {
    const popup = { opener: 'x' as unknown, closed: false, close: vi.fn(), location: { href: '' } };
    vi.stubGlobal('open', vi.fn().mockReturnValue(popup));
    getSummaryUrl.mockRejectedValue(new Error('403'));
    mount(done);
    await userEvent.click(screen.getByTestId('enquadre-summary-download-ev-1'));
    expect(await screen.findByTestId('enquadre-summary-download-error-ev-1')).toBeInTheDocument();
    expect(popup.close).toHaveBeenCalled();
    expect(popup.location.href).toBe('');
  });
});

describe('convocados não identificados', () => {
  it('aparece na linha só com contagem > 0, em es e pt-BR', async () => {
    mount({ ...done, unidentifiedCount: 3 });
    expect(screen.getByTestId('enquadre-seal-unidentified-ev-1').textContent).toBe('Convocados sin identificar: 3');
    cleanup();
    await i18n.changeLanguage('pt-BR');
    mount({ ...done, unidentifiedCount: 3 });
    expect(screen.getByTestId('enquadre-seal-unidentified-ev-1').textContent).toBe('Convocados não identificados: 3');
    cleanup();
    mount(done);
    expect(screen.queryByTestId('enquadre-seal-unidentified-ev-1')).not.toBeInTheDocument();
    await i18n.changeLanguage('es');
  });

  it('é independente da célula do resumo: sem `summary` a contagem continua na linha', () => {
    mount(semCelula({ ...done, unidentifiedCount: 2 }));
    expect(screen.getByTestId('enquadre-seal-unidentified-ev-1').textContent).toBe('Convocados sin identificar: 2');
  });

  it('o motivo do bloqueio é o código do servidor, traduzido (e o código desconhecido aparece como veio)', () => {
    mount({ importStatus: 'blocked', blockedReason: 'wrong_account', unidentifiedCount: 0 });
    expect(screen.getByTestId('enquadre-seal-blocked-reason-ev-1').textContent).toBe('Motivo: La reunión está en otra cuenta de Tactiq');
    cleanup();
    mount({ importStatus: 'blocked', blockedReason: 'codigo_novo', unidentifiedCount: 0 });
    expect(screen.getByTestId('enquadre-seal-blocked-reason-ev-1').textContent).toBe('Motivo: codigo_novo');
  });
});
