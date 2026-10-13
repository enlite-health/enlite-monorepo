import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { RedirectKeepingSearch } from './RedirectKeepingSearch';

function Where(): JSX.Element {
  const loc = useLocation();
  return <span data-testid="where">{loc.pathname + loc.search}</span>;
}

const renderAt = (entry: string) =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/admin/mi-cuenta/tactiq" element={<RedirectKeepingSearch to="/admin/mi-cuenta" />} />
        <Route path="/admin/mi-cuenta" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );

describe('RedirectKeepingSearch — rota antiga /admin/mi-cuenta/tactiq', () => {
  it('leva ao Perfil PRESERVANDO a query do callback do OAuth (?tactiq=linked|error&reason=…)', () => {
    renderAt('/admin/mi-cuenta/tactiq?tactiq=error&reason=exchange_failed');
    expect(screen.getByTestId('where')).toHaveTextContent('/admin/mi-cuenta?tactiq=error&reason=exchange_failed');
  });

  it('sem query, leva ao Perfil limpo', () => {
    renderAt('/admin/mi-cuenta/tactiq');
    expect(screen.getByTestId('where').textContent).toBe('/admin/mi-cuenta');
  });
});
