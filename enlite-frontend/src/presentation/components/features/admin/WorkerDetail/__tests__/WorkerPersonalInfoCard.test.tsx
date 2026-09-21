import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

  // Defeito 2 (21/09/2026): `new Date(birthDate).toLocaleDateString('pt-BR')` decodifica
  // "1985-03-25" como meia-noite UTC e formata no fuso LOCAL — em fusos negativos
  // (Argentina, UTC-3) isso exibe "24/03/1985", um dia a menos. O conserto formata a
  // string ISO por split, sem passar por Date/fuso nenhum.
  describe('Defeito 2 — data de nascimento não perde 1 dia por fuso', () => {
    const originalTZ = process.env.TZ;

    afterEach(() => {
      process.env.TZ = originalTZ;
    });

    it('com TZ=America/Argentina/Buenos_Aires (UTC-3): 1985-03-25 exibe 25/03/1985, não 24/03/1985', () => {
      process.env.TZ = 'America/Argentina/Buenos_Aires';
      render(<WorkerPersonalInfoCard {...baseProps} birthDate="1985-03-25" />);
      expect(screen.getByText('25/03/1985')).toBeInTheDocument();
      expect(screen.queryByText('24/03/1985')).not.toBeInTheDocument();
    });

    it('valor legado não-ISO ("25/31/985") é exibido cru, nunca "Invalid Date"', () => {
      render(<WorkerPersonalInfoCard {...baseProps} birthDate="25/31/985" />);
      expect(screen.getByText('25/31/985')).toBeInTheDocument();
      expect(screen.queryByText(/Invalid Date/i)).not.toBeInTheDocument();
    });
  });

  // Defeito 4 (21/09/2026): KMSEncryptionService.decrypt devolve '' (não null) para
  // coluna nula, e AdminWorkersDetailBuilder faz `?? null` — que não pega string vazia.
  // Conserto no FRONT: o Field trata string vazia/só-espaço como ausente.
  describe('Defeito 4 — campo PII vazio (string) mostra "—", não branco', () => {
    it('sexualOrientation/race/religion como string vazia → "—"', () => {
      render(
        <WorkerPersonalInfoCard
          {...baseProps}
          sexualOrientation=""
          race=""
          religion=""
        />,
      );
      // 3 campos vazios + possíveis outros "—" já cobertos noutro teste — aqui
      // garantimos que NENHUM dos três aparece como texto vazio/só-espaço.
      expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
    });

    it('sexualOrientation só com espaços → "—"', () => {
      render(<WorkerPersonalInfoCard {...baseProps} sexualOrientation="   " />);
      expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
    });
  });
});
