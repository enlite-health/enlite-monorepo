/**
 * AdmisionPage.name.test.tsx — D249
 *
 * O campo que faltava. Até 02/09 o formulário não colhia nome (decisão de
 * produto `2026-07-27a#DEC-02`), e o efeito medido em produção foram 13 de 13
 * leads chegando como "Solicitante" — cards indistinguíveis para quem precisa
 * ligar dentro do SLA de 24h.
 *
 * A tela valida o mesmo que o servidor (`publicLeadSchema`): nome obrigatório e
 * com ao menos dois termos. A tela avisa antes; o servidor é quem garante.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AdmisionPage from '../AdmisionPage';

const createLead = vi.fn();
vi.mock('@infrastructure/http/LeadsApiService', () => ({
  LeadsApiService: { createLead: (...a: unknown[]) => createLead(...a) },
}));
vi.mock('@infrastructure/http/AdmissionApiService', () => ({
  AdmissionApiService: {
    getSlots: vi.fn().mockResolvedValue([]),
    bookSlot: vi.fn(),
  },
}));

function preencher(nome: string | null) {
  // serviceType e requesterType também são obrigatórios — sem eles o zod barra
  // por OUTRO motivo e o teste do nome não estaria medindo o que diz medir.
  fireEvent.change(screen.getByTestId('lead-serviceType'), { target: { value: 'cuidadores' } });
  fireEvent.click(screen.getByTestId('lead-requesterType-patient'));
  if (nome !== null) {
    fireEvent.change(screen.getByTestId('lead-name'), { target: { value: nome } });
  }
  fireEvent.change(screen.getByTestId('lead-email'), { target: { value: 'p@example.com' } });
  fireEvent.change(screen.getByTestId('lead-phone'), { target: { value: '+5491122334455' } });
  fireEvent.click(screen.getByTestId('lead-consent'));
  fireEvent.submit(screen.getByTestId('lead-form'));
}

describe('AdmisionPage — nome completo (D249)', () => {
  beforeEach(() => {
    createLead.mockReset();
    createLead.mockResolvedValue({ id: 'lead-1' });
    render(
      <MemoryRouter>
        <AdmisionPage country="AR" />
      </MemoryRouter>,
    );
  });

  it('o campo existe na tela — era exatamente o que faltava', () => {
    expect(screen.getByTestId('lead-name')).toBeInTheDocument();
  });

  it('sem nome, o formulário NÃO envia', async () => {
    preencher(null);
    await waitFor(() => expect(createLead).not.toHaveBeenCalled());
  });

  it('com um termo só, o formulário NÃO envia — exige nome e sobrenome', async () => {
    preencher('Flavia');
    await waitFor(() => expect(createLead).not.toHaveBeenCalled());
  });

  it('com nome e sobrenome, envia o nome inteiro em UM campo', async () => {
    preencher('Flavia Villagra');
    await waitFor(() => expect(createLead).toHaveBeenCalledTimes(1));
    expect(createLead.mock.calls[0][0]).toMatchObject({ name: 'Flavia Villagra' });
  });

  it('a quebra em nome/sobrenome é do SERVIDOR — a tela manda o texto como veio', async () => {
    preencher('  María de los Ángeles Pérez  ');
    await waitFor(() => expect(createLead).toHaveBeenCalledTimes(1));
    // Só o trim das pontas; nem split nem toLowerCase acontecem aqui.
    expect(createLead.mock.calls[0][0].name).toBe('María de los Ángeles Pérez');
  });
});
