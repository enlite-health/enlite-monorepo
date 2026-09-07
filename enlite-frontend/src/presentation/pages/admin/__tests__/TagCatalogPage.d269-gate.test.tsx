/**
 * TagCatalogPage.d269-gate.test.tsx
 *
 * D269 (rodada 6 do gate): `/admin/tags` — POST/PATCH/DELETE
 * `/api/admin/worker-tags` → `worker:write`. "Nueva etiqueta" virou
 * `ActionButton`; editar/excluir por linha só monta quando a célula não
 * está negada (`!tagWriteGate.denied`). Mesmo padrão de mock de store de
 * `AdminUsersPage.test.tsx`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';
import type { WorkerTag } from '@domain/entities/WorkerTag';

// `t` estável (mesma referência a cada render) — `fetchTags` é
// `useCallback(..., [t])`; um `t` novo a cada `useTranslation()` reexecuta o
// efeito de fetch em loop e o `findByText` nunca vê o estado assentado.
vi.mock('react-i18next', () => {
  const t = (k: string) => k;
  return { useTranslation: () => ({ t }) };
});

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const real = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...real, useNavigate: () => mockNavigate };
});

const TAGS: WorkerTag[] = [
  {
    id: 'tag-1',
    name: 'Bilingüe',
    color: '#180149',
    description: 'Habla inglés',
    createdBy: 'admin-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
];

const mockListWorkerTags = vi.fn();
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    listWorkerTags: (...args: any[]) => mockListWorkerTags(...args),
    updateWorkerTag: vi.fn(),
    createWorkerTag: vi.fn(),
    deleteWorkerTag: vi.fn(),
  },
}));

import TagCatalogPage from '../TagCatalogPage';

function montar() {
  return render(
    <MemoryRouter initialEntries={['/admin/tags']}>
      <TagCatalogPage />
    </MemoryRouter>,
  );
}

const contrato = (permissions: string[], enforcement: AuthzContract['enforcement']): AuthzContract => ({
  uid: 'u',
  tenantId: 't',
  status: 'ACTIVE',
  permissions,
  countries: [],
  groups: [],
  features: {},
  enforcement,
});

describe('TagCatalogPage — D269 gate de escrita (worker:write)', () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    mockListWorkerTags.mockReset();
    mockListWorkerTags.mockResolvedValue(TAGS);
  });
  afterEach(() => useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' }));

  it('enforcement "on" SEM worker:write → "Nueva etiqueta" some, e a linha não tem editar/excluir', async () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato(['worker:read'], 'on') });
    montar();

    expect(await screen.findByText('Bilingüe')).toBeInTheDocument();
    expect(screen.queryByText('admin.tags.newTag')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('admin.tags.editTag')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('admin.tags.deleteTag')).not.toBeInTheDocument();
  });

  it('enforcement "on" COM worker:write → "Nueva etiqueta" aparece, e a linha tem editar/excluir', async () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato(['worker:read', 'worker:write'], 'on') });
    montar();

    expect(await screen.findByText('Bilingüe')).toBeInTheDocument();
    expect(screen.getByText('admin.tags.newTag')).toBeInTheDocument();
    expect(screen.getByLabelText('admin.tags.editTag')).toBeInTheDocument();
    expect(screen.getByLabelText('admin.tags.deleteTag')).toBeInTheDocument();
  });

  it('enforcement "off" (sem contrato) → comportamento atual: botões visíveis', async () => {
    montar();

    expect(await screen.findByText('Bilingüe')).toBeInTheDocument();
    expect(screen.getByText('admin.tags.newTag')).toBeInTheDocument();
    expect(screen.getByLabelText('admin.tags.editTag')).toBeInTheDocument();
    expect(screen.getByLabelText('admin.tags.deleteTag')).toBeInTheDocument();
  });
});

// ── Guarda de rota: a célula de LEITURA (`worker:read`), não mais o papel ──────
describe('TagCatalogPage — guarda de rota por célula (worker:read)', () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    mockListWorkerTags.mockReset();
    mockListWorkerTags.mockResolvedValue(TAGS);
  });
  afterEach(() => useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' }));

  it('enforcement "on" SEM worker:read → redireciona para /admin', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato([], 'on') });
    montar();
    expect(mockNavigate).toHaveBeenCalledWith('/admin', { replace: true });
  });

  it('enforcement "on" COM worker:read → não redireciona', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato(['worker:read'], 'on') });
    montar();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('enforcement "off" sem célula nenhuma → não redireciona (a tela abre como sempre abriu)', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato([], 'off') });
    montar();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
