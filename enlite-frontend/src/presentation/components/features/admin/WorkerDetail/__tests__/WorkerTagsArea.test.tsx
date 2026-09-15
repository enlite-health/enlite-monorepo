import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { WorkerTagsArea } from '../WorkerTagsArea';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { WorkerTag, WorkerTagSummary } from '@domain/entities/WorkerTag';
import type { AuthzContract } from '@domain/entities/Authz';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    listWorkerTags: vi.fn(),
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

const catalog: WorkerTag[] = [
  { id: 't1', name: 'Urgente', color: '#ff0000', createdBy: 'a', createdAt: 'x', updatedAt: 'x' },
  { id: 't2', name: 'VIP', color: '#f5f5f5', createdBy: 'a', createdAt: 'x', updatedAt: 'x' },
];

const assignedTag: WorkerTagSummary = { id: 't1', name: 'Urgente', color: '#ff0000' };

describe('WorkerTagsArea', () => {
  beforeEach(() => {
    vi.mocked(AdminApiService.listWorkerTags).mockReset().mockResolvedValue(catalog);
    vi.mocked(AdminApiService.assignTagToWorker).mockReset().mockResolvedValue(undefined as never);
    vi.mocked(AdminApiService.removeTagFromWorker).mockReset().mockResolvedValue(undefined as never);
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
  });

  it('tag clara (luminância alta) usa texto escuro; tag escura usa texto claro', () => {
    const light: WorkerTagSummary = { id: 't2', name: 'Clara', color: '#ffffff' };
    render(<WorkerTagsArea workerId="w1" initialTags={[assignedTag, light]} />);
    const darkText = screen.getByText('Urgente').closest('span')!;
    const lightText = screen.getByText('Clara').closest('span')!;
    expect(darkText).toHaveStyle({ color: '#ffffff' });
    expect(lightText).toHaveStyle({ color: '#1a1a1a' });
  });

  it('sem tags: mostra "sem tags"', () => {
    render(<WorkerTagsArea workerId="w1" initialTags={[]} />);
    expect(screen.getByText('admin.workerDetail.tags.noTags')).toBeInTheDocument();
  });

  it('adiciona uma tag: abre o dropdown, clica na opção e chama assignTagToWorker', async () => {
    render(<WorkerTagsArea workerId="w1" initialTags={[]} />);
    await waitFor(() => expect(AdminApiService.listWorkerTags).toHaveBeenCalled());
    fireEvent.click(screen.getByText('admin.workerDetail.tags.addTag'));
    fireEvent.click(await screen.findByText('Urgente'));
    await waitFor(() => expect(AdminApiService.assignTagToWorker).toHaveBeenCalledWith('w1', 't1'));
    expect(screen.getByText('Urgente')).toBeInTheDocument();
  });

  it('erro ao adicionar: desfaz o otimismo e mostra o erro', async () => {
    vi.mocked(AdminApiService.assignTagToWorker).mockRejectedValue(new Error('falhou'));
    render(<WorkerTagsArea workerId="w1" initialTags={[]} />);
    await waitFor(() => expect(AdminApiService.listWorkerTags).toHaveBeenCalled());
    fireEvent.click(screen.getByText('admin.workerDetail.tags.addTag'));
    fireEvent.click(await screen.findByText('Urgente'));
    expect(await screen.findByText('admin.workerDetail.tags.assignError')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Urgente')).not.toBeInTheDocument());
  });

  it('remove uma tag: clica no X e chama removeTagFromWorker', async () => {
    render(<WorkerTagsArea workerId="w1" initialTags={[assignedTag]} />);
    fireEvent.click(screen.getByLabelText('admin.workerDetail.tags.removeTag'));
    await waitFor(() => expect(AdminApiService.removeTagFromWorker).toHaveBeenCalledWith('w1', 't1'));
    expect(screen.queryByText('Urgente')).not.toBeInTheDocument();
  });

  it('erro ao remover: desfaz o otimismo e mostra o erro', async () => {
    vi.mocked(AdminApiService.removeTagFromWorker).mockRejectedValue(new Error('falhou'));
    render(<WorkerTagsArea workerId="w1" initialTags={[assignedTag]} />);
    fireEvent.click(screen.getByLabelText('admin.workerDetail.tags.removeTag'));
    expect(await screen.findByText('admin.workerDetail.tags.removeError')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Urgente')).toBeInTheDocument());
  });

  it('busca no dropdown filtra opções e "sem opções" some quando não há match', async () => {
    render(<WorkerTagsArea workerId="w1" initialTags={[]} />);
    await waitFor(() => expect(AdminApiService.listWorkerTags).toHaveBeenCalled());
    fireEvent.click(screen.getByText('admin.workerDetail.tags.addTag'));
    const search = await screen.findByPlaceholderText('admin.workerDetail.tags.addTagPlaceholder');
    fireEvent.change(search, { target: { value: 'zzz-sem-match' } });
    expect(await screen.findByText('admin.workerDetail.tags.noOptions')).toBeInTheDocument();
  });

  it('clique fora fecha o dropdown', async () => {
    render(
      <div>
        <span data-testid="outside">fora</span>
        <WorkerTagsArea workerId="w1" initialTags={[]} />
      </div>,
    );
    await waitFor(() => expect(AdminApiService.listWorkerTags).toHaveBeenCalled());
    fireEvent.click(screen.getByText('admin.workerDetail.tags.addTag'));
    expect(await screen.findByText('Urgente')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByTestId('outside'));
    await waitFor(() => expect(screen.queryByText('Urgente')).not.toBeInTheDocument());
  });

  it('re-sincroniza as tags quando initialTags muda (re-render do pai)', () => {
    const { rerender } = render(<WorkerTagsArea workerId="w1" initialTags={[]} />);
    expect(screen.queryByText('Urgente')).not.toBeInTheDocument();
    rerender(<WorkerTagsArea workerId="w1" initialTags={[assignedTag]} />);
    expect(screen.getByText('Urgente')).toBeInTheDocument();
  });

  it('catálogo falha ao carregar: dropdown fica vazio sem quebrar', async () => {
    vi.mocked(AdminApiService.listWorkerTags).mockRejectedValue(new Error('falhou'));
    render(<WorkerTagsArea workerId="w1" initialTags={[]} />);
    fireEvent.click(screen.getByText('admin.workerDetail.tags.addTag'));
    expect(await screen.findByText('admin.workerDetail.tags.noOptions')).toBeInTheDocument();
  });

  it('D269 — enforcement=on sem worker:write: nem o "X" de remover nem o dropdown de adicionar existem', async () => {
    comEnforcement([], 'on');
    render(<WorkerTagsArea workerId="w1" initialTags={[assignedTag]} />);
    expect(screen.queryByLabelText('admin.workerDetail.tags.removeTag')).not.toBeInTheDocument();
    expect(screen.queryByText('admin.workerDetail.tags.addTag')).not.toBeInTheDocument();
  });

  it('D269 — enforcement=on com worker:write: o "X" e o dropdown existem', () => {
    comEnforcement(['worker:update'], 'on');
    render(<WorkerTagsArea workerId="w1" initialTags={[assignedTag]} />);
    expect(screen.getByLabelText('admin.workerDetail.tags.removeTag')).toBeInTheDocument();
    expect(screen.getByText('admin.workerDetail.tags.addTag')).toBeInTheDocument();
  });
});
