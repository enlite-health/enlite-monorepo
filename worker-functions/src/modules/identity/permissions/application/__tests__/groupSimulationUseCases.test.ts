/**
 * Use cases de simulação de grupo (spec 026, D407) com repositório e publisher
 * FALSOS — molde `groupUseCases.test.ts`. A invariante "só o Acesso Master
 * simula" e "grupo simulável" são do BANCO (`iam.start_group_simulation`, mig
 * 458): aqui se prova que o use case REPASSA o erro traduzido
 * (`PermissionError`) sem reinterpretar, e que o evento de invalidação sai só
 * para o ATOR real (nunca para os membros do grupo simulado — a simulação não
 * é uma mutação de grupo).
 */

import { EndGroupSimulationUseCase } from '../EndGroupSimulationUseCase';
import { ListSimulatableGroupsUseCase } from '../ListSimulatableGroupsUseCase';
import {
  DEFAULT_PERMISSION_SIMULATION_TTL_MINUTES,
  permissionSimulationTtlMinutes,
  simulationTtlInterval,
  StartGroupSimulationUseCase,
} from '../StartGroupSimulationUseCase';
import { PermissionError } from '../../domain/PermissionError';
import type { GroupSimulation } from '../../domain/GroupSimulation';
import type {
  GroupSimulationRepository,
  PermissionEventPublisher,
  PermissionGroupRepository,
} from '../ports';
import type { PermissionGroupDetail } from '../../domain/PermissionGroup';

const TENANT = 'tenant-1';
const UID = 'staff-master';
const MASTER_ID = 'a0000000-0000-0000-0000-000000000001';

function simulation(overrides: Partial<GroupSimulation> = {}): GroupSimulation {
  return {
    id: 'sim-1',
    groupId: 'g2',
    groupName: 'Recrutamento AR',
    startedAt: new Date('2026-09-22T18:00:00Z'),
    expiresAt: new Date('2026-09-22T22:00:00Z'),
    ...overrides,
  };
}

function makeSimRepo(overrides: Partial<jest.Mocked<GroupSimulationRepository>> = {}): jest.Mocked<GroupSimulationRepository> {
  return {
    findActive: jest.fn().mockResolvedValue(null),
    start: jest.fn().mockResolvedValue(simulation()),
    end: jest.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function makeEvents(): jest.Mocked<PermissionEventPublisher> {
  return { permissionChanged: jest.fn().mockResolvedValue(undefined), countryFeatureChanged: jest.fn() };
}

function group(overrides: Partial<PermissionGroupDetail> = {}): PermissionGroupDetail {
  return {
    id: 'g2',
    tenantId: TENANT,
    name: 'Recrutamento AR',
    description: null,
    isSystem: false,
    archivedAt: null,
    createdBy: 'staff:gestor',
    createdAt: new Date('2026-08-16T00:00:00Z'),
    cells: ['vacancy:read'],
    countries: ['AR'],
    memberCount: 3,
    ...overrides,
  };
}

function makeGroupRepo(groups: PermissionGroupDetail[]): jest.Mocked<Pick<PermissionGroupRepository, 'list'>> {
  return { list: jest.fn().mockResolvedValue(groups) };
}

describe('StartGroupSimulationUseCase', () => {
  it('abre a simulação e invalida SÓ o cache do ator real', async () => {
    const repo = makeSimRepo();
    const events = makeEvents();
    const result = await new StartGroupSimulationUseCase(repo, events).execute({
      uid: UID,
      tenantId: TENANT,
      groupId: 'g2',
    });

    expect(result).toEqual(simulation());
    // Formato do TTL: literal de INTERVAL do Postgres "<N> minutes" — sem env,
    // resolve para o default (240) na CONSTRUÇÃO do use case (mesmo molde de
    // `permissionCacheTtlMs`).
    expect(repo.start).toHaveBeenCalledWith(UID, TENANT, 'g2', '240 minutes');
    expect(events.permissionChanged).toHaveBeenCalledWith([UID]);
  });

  it('TTL: default 240min, env válida sobrescreve, env inválida cai no default — sempre "<N> minutes"', () => {
    expect(DEFAULT_PERMISSION_SIMULATION_TTL_MINUTES).toBe(240);
    expect(permissionSimulationTtlMinutes({})).toBe(240);
    expect(permissionSimulationTtlMinutes({ PERMISSION_SIMULATION_TTL_MINUTES: '60' })).toBe(60);
    expect(permissionSimulationTtlMinutes({ PERMISSION_SIMULATION_TTL_MINUTES: 'lixo' })).toBe(240);
    expect(permissionSimulationTtlMinutes({ PERMISSION_SIMULATION_TTL_MINUTES: '-5' })).toBe(240);
    expect(simulationTtlInterval(60)).toBe('60 minutes');
  });

  it('TTL injetado no construtor (não a env) é o que chega ao repositório', async () => {
    const repo = makeSimRepo();
    const events = makeEvents();
    await new StartGroupSimulationUseCase(repo, events, 60).execute({ uid: UID, tenantId: TENANT, groupId: 'g2' });
    expect(repo.start).toHaveBeenCalledWith(UID, TENANT, 'g2', '60 minutes');
  });

  it('42501 do banco (não-Master) chega como PermissionError forbidden, sem reinterpretar', async () => {
    const repo = makeSimRepo({
      start: jest.fn().mockRejectedValue(new PermissionError('forbidden', '[iam] ator não é membro vivo do Acesso Master')),
    });
    const events = makeEvents();
    await expect(
      new StartGroupSimulationUseCase(repo, events).execute({ uid: UID, tenantId: TENANT, groupId: 'g2' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(events.permissionChanged).not.toHaveBeenCalled();
  });

  it('grupo inexistente/arquivado (not_found) e o próprio Master (system_group) propagam intactos', async () => {
    const events = makeEvents();
    await expect(
      new StartGroupSimulationUseCase(
        makeSimRepo({ start: jest.fn().mockRejectedValue(new PermissionError('not_found', 'x')) }),
        events,
      ).execute({ uid: UID, tenantId: TENANT, groupId: 'inexistente' }),
    ).rejects.toMatchObject({ code: 'not_found' });

    await expect(
      new StartGroupSimulationUseCase(
        makeSimRepo({ start: jest.fn().mockRejectedValue(new PermissionError('system_group', 'x')) }),
        events,
      ).execute({ uid: UID, tenantId: TENANT, groupId: MASTER_ID }),
    ).rejects.toMatchObject({ code: 'system_group' });
  });
});

describe('EndGroupSimulationUseCase', () => {
  it('encerra e invalida o cache do ator quando havia simulação aberta', async () => {
    const repo = makeSimRepo({ end: jest.fn().mockResolvedValue(true) });
    const events = makeEvents();
    const result = await new EndGroupSimulationUseCase(repo, events).execute({ uid: UID, tenantId: TENANT });

    expect(result).toEqual({ ended: true });
    expect(repo.end).toHaveBeenCalledWith(UID, TENANT);
    expect(events.permissionChanged).toHaveBeenCalledWith([UID]);
  });

  it('idempotente: nada aberto para fechar ainda assim invalida (o chamador não sabe o estado prévio)', async () => {
    const repo = makeSimRepo({ end: jest.fn().mockResolvedValue(false) });
    const events = makeEvents();
    const result = await new EndGroupSimulationUseCase(repo, events).execute({ uid: UID, tenantId: TENANT });

    expect(result).toEqual({ ended: false });
    expect(events.permissionChanged).toHaveBeenCalledWith([UID]);
  });
});

describe('ListSimulatableGroupsUseCase', () => {
  it('reusa PermissionGroupRepository.list — nenhuma query nova — e tira o Acesso Master', async () => {
    const groups = [
      group({ id: 'master', name: 'Acesso Master', isSystem: true }),
      group({ id: 'g2', name: 'Recrutamento AR', isSystem: false }),
      group({ id: 'g1', name: 'Administración', isSystem: false }),
    ];
    const repo = makeGroupRepo(groups);

    const result = await new ListSimulatableGroupsUseCase(repo as unknown as PermissionGroupRepository).execute({
      tenantId: TENANT,
    });

    expect(repo.list).toHaveBeenCalledWith(TENANT);
    // Sem o Master, e ordenado por nome — nunca a chave do sistema.
    expect(result).toEqual([
      { id: 'g1', name: 'Administración' },
      { id: 'g2', name: 'Recrutamento AR' },
    ]);
  });
});
