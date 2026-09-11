/**
 * clickupSyncEngine — monta o motor de sync do ClickUp (`SyncPatientFromClickUpTaskUseCase`)
 * do jeito que os e2e que testam esse motor DIRETO precisam: mesmas deps que
 * `ClickUpPatientWebhookController.create()` montava (o webhook foi removido em 11/09/2026 —
 * decisão do Gabriel: a plataforma é a fonte, sem sync automático), sem o refresher de
 * catálogo (`ClickUpCatalogRefresher`, removido junto — era defesa específica de um processo
 * de vida longa; aqui o motor roda uma vez por chamada, catálogo sempre fresco).
 *
 * Extraído de vacancy-creation-gaps.e2e.test.ts, vacancy-address-versioning.e2e.test.ts e
 * patient-coverage-survives-clickup-sync.e2e.test.ts, que tinham a MESMA cópia de
 * `makeStubResolver`/`makeUseCase`/`syncTask` (achado do gate `revisao-pr`, critério de
 * repetição de teste). Os três importam daqui — nenhum outro `.e2e.test.ts` deve voltar a
 * declarar a própria cópia.
 */
import {
  PatientService,
  PatientSourceLabelRepository,
  PatientInsuranceVerifiedRepository,
  PatientDeviceTypeRepository,
} from '../../../src/modules/case';
import { ClickUpFieldResolver } from '../../../src/modules/integration/infrastructure/clickup/ClickUpFieldResolver';
import { ClickUpPatientMapper } from '../../../src/modules/integration/infrastructure/clickup/ClickUpPatientMapper';
import {
  SyncPatientFromClickUpTaskUseCase,
  type SyncPatientResult,
} from '../../../src/modules/integration/application/SyncPatientFromClickUpTaskUseCase';
import type { ClickUpTask } from '../../../src/modules/integration/infrastructure/clickup/ClickUpTask';

/**
 * Resolver falso: só o suficiente para o preflight de `ClickUpPatientMapper` passar. Task 1.11:
 * o catálogo diz que os campos EXISTEM (é o que este stub quer dizer com "resolves nothing");
 * `null` aqui significaria campo renomeado/apagado e o mapper recusaria a task inteira, de
 * propósito.
 */
export function makeStubResolver(): ClickUpFieldResolver {
  return {
    resolveDropdown: () => null,
    resolveLabel:    () => null,
    resolveLabels:   () => [],
    getFieldType:    () => 'drop_down',
    dropdownFieldNames: [],
    labelsFieldNames:   [],
    getDropdownOptions: () => ({}),
    getLabelsOptions:   () => ({}),
  } as unknown as ClickUpFieldResolver;
}

/**
 * Mesmas deps que `ClickUpPatientWebhookController.create()` montava (removido) — sem o
 * refresher de catálogo.
 */
export function makeUseCase(): SyncPatientFromClickUpTaskUseCase {
  const resolver = makeStubResolver();
  return new SyncPatientFromClickUpTaskUseCase({
    mapper:                new ClickUpPatientMapper(resolver),
    patientService:        new PatientService(),
    sourceLabelRepository: new PatientSourceLabelRepository(),
    insuranceRepository:   new PatientInsuranceVerifiedRepository(),
    deviceTypeRepository:  new PatientDeviceTypeRepository(),
  });
}

export async function syncTask(
  useCase: SyncPatientFromClickUpTaskUseCase,
  task: ClickUpTask,
): Promise<SyncPatientResult> {
  return useCase.execute(task, { onMissingContact: 'flag' });
}
