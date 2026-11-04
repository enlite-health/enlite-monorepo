import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ContadorAceitos } from '../ContadorAceitos';
import type { ContadoresAceitos } from '@infrastructure/http/AdminPedidosIaApiService';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o ? `${k}:${JSON.stringify(o)}` : k) }),
}));
const getContadores = vi.fn();
vi.mock('@infrastructure/http/AdminPedidosIaApiService', () => ({
  AdminPedidosIaApiService: { getContadores: (...a: unknown[]) => getContadores(...a) },
}));

const dado = (over = {}) => ({
  semanasValidasSeguidas: 3, reguaSemanas: 4, atingiuRegua: false, ultimaContestacaoSemana: '2026-10-05', pendentes: 1, pedidos: 7, ...over,
});
const resposta = (c1 = {}, c2 = {}): ContadoresAceitos => ({
  contador1: dado(c1), contador2: dado({ reguaSemanas: 26, ...c2 }), janela: { de: '2026-09-01', ate: '2026-11-01' },
});

describe('ContadorAceitos', () => {
  beforeEach(() => { getContadores.mockReset(); vi.spyOn(console, 'error').mockImplementation(() => {}); });

  it('mostra os dois contadores com semanas, régua, última contestação e pendentes', async () => {
    getContadores.mockResolvedValue(resposta({}, { semanasValidasSeguidas: 26, atingiuRegua: true, ultimaContestacaoSemana: null }));
    render(<ContadorAceitos />);
    await waitFor(() => expect(screen.getByTestId('contador-1')).toBeInTheDocument());
    expect(screen.getByTestId('contador-1-semanas')).toHaveTextContent('3');
    expect(screen.getByTestId('contador-1-regua')).toHaveTextContent('"regua":4');
    expect(screen.getByTestId('contador-1-ultima-contestacao')).toHaveTextContent('2026-10-05');
    expect(screen.getByTestId('contador-1-pendentes')).toHaveTextContent('"count":1');
    expect(screen.getByTestId('contador-2')).toHaveAttribute('data-atingiu', 'true');
    expect(screen.getByTestId('contador-2-ultima-contestacao')).toHaveTextContent('semContestacao');
  });

  it('com 0 pedidos mostra "0" e o estado vazio, sem erro nem régua', async () => {
    getContadores.mockResolvedValue(resposta({ pedidos: 0, semanasValidasSeguidas: 0 }, { pedidos: 0, semanasValidasSeguidas: 0 }));
    render(<ContadorAceitos />);
    await waitFor(() => expect(screen.getByTestId('contador-1-vazio')).toBeInTheDocument());
    expect(screen.getByTestId('contador-1-semanas')).toHaveTextContent(/^0$/);
    expect(screen.queryByTestId('contador-1-regua')).toBeNull();
    expect(screen.queryByTestId('contador-aceitos-erro')).toBeNull();
    expect(screen.getByTestId('contador-aceitos').textContent).not.toContain('%');
  });

  it('em erro mostra aviso discreto e não lança', async () => {
    getContadores.mockRejectedValue(new Error('boom'));
    render(<ContadorAceitos />);
    await waitFor(() => expect(screen.getByTestId('contador-aceitos-erro')).toBeInTheDocument());
    expect(screen.queryByTestId('contador-1')).toBeNull();
  });
});
