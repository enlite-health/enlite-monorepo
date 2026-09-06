import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';
import { ContainerGate } from '../ContainerGate';

const contrato = (permissions: string[], enforcement: AuthzContract['enforcement']): AuthzContract => ({
  uid: 'u1', tenantId: 't1', status: 'ACTIVE', permissions, countries: ['AR'], groups: [], features: {}, enforcement,
});

describe('ContainerGate (D286)', () => {
  beforeEach(() => useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' }));

  it('🔴 enforcement=on sem a célula: o container NÃO está no DOM', () => {
    useAdminAuthStore.setState({ authz: contrato(['patient:read'], 'on'), authzStatus: 'ready' });
    render(<ContainerGate resource="patient_family"><div data-testid="card" /></ContainerGate>);
    expect(screen.queryByTestId('card')).not.toBeInTheDocument();
  });

  it('enforcement=on com leitura: aparece; a função filha recebe canWrite', () => {
    useAdminAuthStore.setState({ authz: contrato(['patient_family:read'], 'on'), authzStatus: 'ready' });
    render(<ContainerGate resource="patient_family">{({ canWrite }) => <div data-testid="card">{canWrite ? 'edita' : 'só lê'}</div>}</ContainerGate>);
    expect(screen.getByTestId('card')).toHaveTextContent('só lê');
  });

  it('enforcement OFF: aparece mesmo sem célula (o rollout não pode apagar a ficha)', () => {
    useAdminAuthStore.setState({ authz: contrato([], 'off'), authzStatus: 'ready' });
    render(<ContainerGate resource="patient_family"><div data-testid="card" /></ContainerGate>);
    expect(screen.getByTestId('card')).toBeInTheDocument();
  });
});
