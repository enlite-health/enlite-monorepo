import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { VacancyEnAliasRedirect } from '../App';

/**
 * Regressão: links de match de vaga foram disparados em inglês
 * (https://app.enlite.health/vacancies/:id) enquanto a rota pública real é em
 * espanhol (/vacantes/:id), resultando em tela branca. O alias EN→ES resgata
 * esses links já enviados. Ver VacancyAutoInviteHandler (backend) + App.tsx.
 */
function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/vacancies/:id" element={<VacancyEnAliasRedirect />} />
        <Route path="/vacantes/:id" element={<Landing />} />
      </Routes>
    </MemoryRouter>,
  );
}

function Landing() {
  // Ecoa o que a rota destino recebeu para asserção
  const { pathname, search } = useLocation();
  return (
    <div>
      <span data-testid="path">{pathname}</span>
      <span data-testid="query">{new URLSearchParams(search).toString()}</span>
    </div>
  );
}

describe('VacancyEnAliasRedirect (alias EN → ES de vaga)', () => {
  it('redireciona /vacancies/:id (UUID) para /vacantes/:id', () => {
    renderAt('/vacancies/921170f9-4ac5-4404-874e-6e53cead275b');
    expect(screen.getByTestId('path').textContent).toBe(
      '/vacantes/921170f9-4ac5-4404-874e-6e53cead275b',
    );
  });

  it('preserva a query string ao redirecionar', () => {
    renderAt('/vacancies/abc-123?utm_source=whatsapp');
    expect(screen.getByTestId('path').textContent).toBe('/vacantes/abc-123');
    expect(screen.getByTestId('query').textContent).toBe('utm_source=whatsapp');
  });

  it('limpa ponto final colado pelo autolink do WhatsApp', () => {
    renderAt('/vacancies/abc-123.');
    expect(screen.getByTestId('path').textContent).toBe('/vacantes/abc-123');
  });
});
