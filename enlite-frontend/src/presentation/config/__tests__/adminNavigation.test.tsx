/**
 * adminNavigation.test.tsx — spec 029 (prompts de IA editáveis), T025.
 *
 * O item de menu dos prompts de IA deriva da CÉLULA da tela que ele abre, como todos os outros
 * desde a D269: `screenByRoute('/admin/prompts-ia')` → `integration.aiPrompts` → `ai_prompt:*`.
 * Não há lista à mão em lugar nenhum.
 *
 * ⚠️ Contar a ocorrência do texto no arquivo provaria só que alguém digitou a palavra — por isso
 * este teste RENDERIZA a navegação e afirma destino e rótulo, com e sem a permissão.
 *
 * Molde: `adminNavigation.d269-cells.test.tsx` (vizinho), mesmo contrato e mesmo freio de rollout.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAdminNavItems } from '../adminNavigation';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const HREF_PROMPTS = '/admin/prompts-ia';

const contrato = (
  permissions: string[],
  enforcement: AuthzContract['enforcement'],
): AuthzContract => ({
  uid: 'u',
  tenantId: 't',
  status: 'ACTIVE',
  permissions,
  countries: [],
  groups: [],
  features: {},
  enforcement,
});

const itens = () => renderHook(() => useAdminNavItems()).result.current;

afterEach(() => useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' }));

describe('item de prompts de IA', () => {
  it('COM ai_prompt:read → o item aparece, com o destino e o rótulo traduzido', () => {
    useAdminAuthStore.setState({
      authzStatus: 'ready',
      authz: contrato(['ai_prompt:read'], 'on'),
    });

    const item = itens().find((i) => i.href === HREF_PROMPTS);
    expect(item).toBeDefined();
    expect(item?.label).toBe('admin.nav.aiPrompts');
  });

  it('SEM nenhuma célula ai_prompt → o item NÃO aparece', () => {
    useAdminAuthStore.setState({
      authzStatus: 'ready',
      authz: contrato(['tag:read', 'dedup:read'], 'on'),
    });

    expect(itens().map((i) => i.href)).not.toContain(HREF_PROMPTS);
  });

  it('COM ai_prompt:update (sem read) → o item aparece: qualquer célula da tela basta', () => {
    useAdminAuthStore.setState({
      authzStatus: 'ready',
      authz: contrato(['ai_prompt:update'], 'on'),
    });

    expect(itens().map((i) => i.href)).toContain(HREF_PROMPTS);
  });
});
