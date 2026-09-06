import { NOME_REDIGIDO } from '@modules/identity/permissions';
import {
  ALL_WORKER_CONTAINERS_READABLE, WORKER_CONTAINERS, canReadWorkerContainer, projectPatientNameInEngagement,
  servedWorkerContainers, workerContainerCell, workerContainerReadsOf, workerDetailTrailAction, workerDetailTrailOf, workerRedactionMarker,
} from '../workerContainerAccess';

describe('workerContainerAccess — a célula de cada container da ficha do prestador (D286 fase 2)', () => {
  it('5 containers: os 3 níveis da C3/F2, mais endereço (célula nova, espelho de patient_address) e os blocos anexos', () => {
    expect(WORKER_CONTAINERS).toEqual(['contact', 'dossier', 'address', 'documents', 'encuadres']);
    expect(WORKER_CONTAINERS.map(workerContainerCell)).toEqual(['worker_contact:read', 'worker_pii:read', 'worker_address:read', 'worker_document:read', 'match:read']);
  });

  it('cells = null / undefined → tudo legível (engine não decidiu, D113); [] → nada', () => {
    expect(workerContainerReadsOf(null)).toEqual({ contact: true, dossier: true, address: true, documents: true, encuadres: true, patientIdentity: true });
    expect(workerContainerReadsOf(undefined)).toEqual(ALL_WORKER_CONTAINERS_READABLE);
    expect(workerContainerReadsOf([])).toEqual({ contact: false, dossier: false, address: false, documents: false, encuadres: false, patientIdentity: false });
    expect(canReadWorkerContainer(undefined, 'dossier')).toBe(true);
  });

  it('cada célula abre SÓ o seu container; patient_identity:read é a do OUTRO titular', () => {
    expect(workerContainerReadsOf(['worker_pii:read'])).toMatchObject({ dossier: true, address: false, contact: false, documents: false, encuadres: false, patientIdentity: false });
    expect(workerContainerReadsOf(['worker_address:read'])).toMatchObject({ address: true, dossier: false });
    expect(workerContainerReadsOf(['patient_identity:read'])).toMatchObject({ patientIdentity: true, encuadres: false });
  });

  it('servedWorkerContainers é o que a trilha grava — na ordem fixa', () => {
    expect(servedWorkerContainers(null)).toEqual(['contact', 'dossier', 'address', 'documents', 'encuadres']);
    expect(servedWorkerContainers(['match:read', 'worker_contact:read'])).toEqual(['contact', 'encuadres']);
    expect(servedWorkerContainers([])).toEqual([]);
  });

  it('o `action` da trilha é ENUMERADO: read_detail + containers servidos; sem nenhum, só read_detail', () => {
    expect(workerDetailTrailAction(null)).toBe('read_detail:contact+dossier+address+documents+encuadres');
    expect(workerDetailTrailAction(['worker:read', 'worker_pii:read'])).toBe('read_detail:dossier');
    expect(workerDetailTrailAction(['worker:read'])).toBe('read_detail');
    // lido da request (o que a rota passa ao logResourceAccess); sem `permissionCells` = engine indeciso
    expect(workerDetailTrailOf({ permissionCells: ['worker:read', 'match:read'] })).toBe('read_detail:encuadres');
    expect(workerDetailTrailOf({})).toBe('read_detail:contact+dossier+address+documents+encuadres');
  });

  it('marcador: undefined quando nada foi redigido (resposta byte a byte a de antes); senão só os ocultos, sempre true', () => {
    expect(workerRedactionMarker(workerContainerReadsOf(null))).toBeUndefined();
    expect(workerRedactionMarker(workerContainerReadsOf(['worker_contact:read']))).toEqual({ dossier: true, address: true, documents: true, encuadres: true });
  });

  it('nome do paciente no encuadre: NOME_REDIGIDO sem a célula de identidade — nunca vazio', () => {
    expect(projectPatientNameInEngagement('Juan Perez', workerContainerReadsOf(['match:read']))).toBe(NOME_REDIGIDO);
    expect(projectPatientNameInEngagement(null, workerContainerReadsOf(['match:read']))).toBe(NOME_REDIGIDO);
    expect(projectPatientNameInEngagement('Juan Perez', workerContainerReadsOf(['match:read', 'patient_identity:read']))).toBe('Juan Perez');
    expect(projectPatientNameInEngagement(null, workerContainerReadsOf(null))).toBeNull();
  });
});
