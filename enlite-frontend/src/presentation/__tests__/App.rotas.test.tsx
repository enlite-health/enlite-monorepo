/**
 * App.rotas.test.tsx — spec 029 (prompts de IA editáveis), T026.
 *
 * Prova que `App.tsx` ROTEIA `/admin/prompts-ia` para a `AiPromptsPage`. A tabela de rotas sob
 * teste é a real, do `App.tsx` — não uma cópia montada aqui, que provaria só o próprio teste.
 *
 * O que é dublê, e por quê:
 *   - `AiPromptsPage` vira um marcador. A alegação desta tarefa é "a rota chega nesta página",
 *     não "a página funciona" — isso é a T027 (e2e humano), com API e banco reais.
 *   - `AdminProtectedRoute` e `AdminLayout` viram casca: autenticação e o esqueleto do admin têm
 *     testes próprios e não são o que se afirma aqui.
 *
 * `App` monta `BrowserRouter` por dentro, então o endereço se escolhe por `history.pushState`,
 * não por `MemoryRouter`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Outlet } from 'react-router-dom';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

vi.mock('../pages/admin/AiPromptsPage/AiPromptsPage', () => ({
  AiPromptsPage: () => <div data-testid="pagina-prompts-ia">prompts</div>,
}));

vi.mock('../components/features/admin/AdminProtectedRoute', () => ({
  AdminProtectedRoute: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../components/features/admin/AdminLayout', () => ({
  AdminLayout: () => <Outlet />,
}));

import { App } from '../App';

describe('rota de prompts de IA', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/admin/prompts-ia');
  });

  it('navegar para /admin/prompts-ia monta a página de prompts de IA', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('pagina-prompts-ia')).toBeInTheDocument();
    });
  });
});
