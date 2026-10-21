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

// ⚠️ O caminho tem de ser o que o `App.tsx` IMPORTA, não um parecido. Até 29/09/2026 este mock
// apontava para `../components/features/admin/AdminLayout`, que NÃO EXISTE (o real é
// `templates/AdminLayout/AdminLayout`). `vi.mock` de caminho inexistente não reclama: o mock
// simplesmente não pega, o `AdminLayout` de verdade monta, `useAdminAuth` estoura
// "Firebase Auth not initialized" e o `AdminErrorBoundary` troca a tela. O teste virou corrida
// entre o `waitFor` e o boundary — passou no CI uma vez e falhou na seguinte, sem nada mudar.
vi.mock('../components/templates/AdminLayout/AdminLayout', () => ({
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

    // Trava contra o defeito acima voltar em silêncio: se algum mock deixar de pegar, o
    // `AdminErrorBoundary` assume e mostra este título. Sem esta asserção, a falha volta a ser
    // uma corrida que às vezes o teste ganha.
    expect(screen.queryByText('No pudimos cargar esta página')).not.toBeInTheDocument();
  });
});
