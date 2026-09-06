import { PatientClinicalRepository } from '../infrastructure/PatientClinicalRepository';
import { PatientResponsibleRepository } from '../infrastructure/PatientResponsibleRepository';
import { GeocodingService } from '../../../infrastructure/services/GeocodingService';
import { replacePatientAddresses, replacePatientProfessionals } from './PatientRelatedWriter';
import type { PatientRelatedInput } from './PatientWriteInputs';

/**
 * PatientRelatedUpsert — o passo "grava as coleções auxiliares deste paciente", compartilhado
 * pelos DOIS caminhos de escrita: o espelho do ClickUp (`PatientService`) e a criação nativa
 * (`PatientNativeCreator`).
 *
 * Veio de `PatientService.upsertRelated` quando aquele arquivo passou do teto de 400 linhas.
 * Arquivo PRÓPRIO, e não dentro de `PatientRelatedWriter`, porque aquele módulo é dublado
 * inteiro por `jest.mock` em 5 suítes — acrescentar uma função lá a deixaria `undefined` nos
 * dublês. Aqui ele é IMPORTADO (e portanto continua dublado quando a suíte o dubla), que é
 * exatamente o comportamento anterior.
 */

/** O que a escrita das coleções precisa do serviço. */
export interface PatientRelatedUpsertDeps {
  clinicalRepo: PatientClinicalRepository;
  responsibleRepo: PatientResponsibleRepository;
  geocoder: GeocodingService;
}

/**
 * As coleções auxiliares + o bloco clínico de um paciente, no MESMO client de transação do
 * chamador — o caminho compartilhado pelo espelho do ClickUp e pela criação nativa.
 *
 * Veio de `PatientService.upsertRelated` quando aquele arquivo passou do teto de 400 linhas.
 * Está aqui, e não lá, porque é exatamente a responsabilidade que este arquivo já declara no
 * topo: escrever as coleções penduradas no paciente, sem regra de negócio.
 */
export async function upsertPatientRelated(
  deps: PatientRelatedUpsertDeps,
  patientId: string,
  input: PatientRelatedInput,
  client: import('pg').PoolClient,
): Promise<void> {
  await deps.clinicalRepo.upsert(
    {
      patientId,
      diagnosis:             input.diagnosis,
      dependencyLevel:       input.dependencyLevel,
      dependencyLevelReadable: input.dependencyLevelReadable,
      clinicalSpecialty:     input.clinicalSpecialty,
      clinicalSpecialtyReadable: input.clinicalSpecialtyReadable,
      clinicalSegments:      input.clinicalSegments,
      serviceType:           input.serviceType,
      serviceTypeReadable:   input.serviceTypeReadable,
      additionalComments:    input.additionalComments,
      emergencyInstructions: input.emergencyInstructions,
      hasJudicialProtection: input.hasJudicialProtection,
      hasCud:                input.hasCud,
      hasConsent:            input.hasConsent,
    },
    client,
  );

  if (input.responsibles !== undefined) {
    // SYNC/criação: substitui SÓ as linhas 'clickup'. Familiar do painel
    // ('admin_manual') ou do formulário ('web_form') sobrevive ao próximo
    // taskUpdated — o mapper devolve [] e o replaceAll apagava tudo (QA 🔴1).
    // O drawer (updatePatientSection 'support-network') continua replaceAll.
    await deps.responsibleRepo.replaceBySource(patientId, input.responsibles, 'clickup', client);
  }

  if (input.addresses !== undefined) {
    await replacePatientAddresses(patientId, input.addresses, client, deps.geocoder);
  }

  if (input.professionals !== undefined) {
    await replacePatientProfessionals(patientId, input.professionals, client);
  }
}
