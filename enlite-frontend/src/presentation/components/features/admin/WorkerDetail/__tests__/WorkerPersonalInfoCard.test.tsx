import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WorkerPersonalInfoCard } from '../WorkerPersonalInfoCard';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    listWorkerTags: vi.fn().mockResolvedValue([]),
    assignTagToWorker: vi.fn(),
    removeTagFromWorker: vi.fn(),
  },
}));

function comEnforcement(permissions: string[], enforcement: AuthzContract['enforcement']) {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: {
      uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement,
    } as AuthzContract,
  });
}

const baseProps = {
  workerId: 'w1',
  birthDate: '1990-05-10',
  sex: 'F',
  gender: 'FEMALE',
  sexualOrientation: 'HETEROSEXUAL',
  race: 'BLANCA',
  religion: 'CATOLICA',
  languages: ['es', 'en'],
  weightKg: '60',
  heightCm: '1.65',
  tags: [],
};

describe('WorkerPersonalInfoCard', () => {
  beforeEach(() => {
    vi.mocked(AdminApiService.listWorkerTags).mockReset().mockResolvedValue([]);
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
  });

  it('sem onEdit: não renderiza o botão de editar', () => {
    render(<WorkerPersonalInfoCard {...baseProps} />);
    expect(screen.queryByTestId('worker-edit-button')).not.toBeInTheDocument();
  });

  it('com onEdit (default: sem enforcement): renderiza o botão e chama onEdit ao clicar', () => {
    const onEdit = vi.fn();
    render(<WorkerPersonalInfoCard {...baseProps} onEdit={onEdit} />);
    const btn = screen.getByTestId('worker-edit-button');
    expect(btn).toBeInTheDocument();
    btn.click();
    expect(onEdit).toHaveBeenCalled();
  });

  it('D269 — enforcement=on sem worker:write: onEdit passado mas o botão NÃO existe', () => {
    comEnforcement([], 'on');
    render(<WorkerPersonalInfoCard {...baseProps} onEdit={vi.fn()} />);
    expect(screen.queryByTestId('worker-edit-button')).not.toBeInTheDocument();
  });

  it('D269 — enforcement=on com worker:write: o botão existe', () => {
    comEnforcement(['worker:update'], 'on');
    render(<WorkerPersonalInfoCard {...baseProps} onEdit={vi.fn()} />);
    expect(screen.getByTestId('worker-edit-button')).toBeInTheDocument();
  });

  it('renderiza os campos pessoais formatados', () => {
    render(<WorkerPersonalInfoCard {...baseProps} />);
    expect(screen.getByText('60kg')).toBeInTheDocument();
    expect(screen.getByText('1.65m')).toBeInTheDocument();
  });

  it('sem birthDate/languages: mostra "—"', () => {
    render(<WorkerPersonalInfoCard {...baseProps} birthDate={null} languages={[]} weightKg={null} heightCm={null} />);
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});
