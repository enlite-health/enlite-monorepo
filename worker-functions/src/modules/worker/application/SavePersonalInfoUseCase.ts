import { IWorkerRepository } from '../ports/IWorkerRepository';
import { SavePersonalInfoDTO, Worker } from '../domain/Worker';
import { WORKER_ERROR_CODES } from '../domain/workerErrors';
import { Result } from '@shared/utils/Result';
import { normalizePhoneAR, generatePhoneCandidates } from '@shared/utils/phoneNormalization';
export class SavePersonalInfoUseCase {
  constructor(
    private workerRepository: IWorkerRepository,
  ) {}

  async execute(data: SavePersonalInfoDTO): Promise<Result<Worker>> {
    const workerResult = await this.workerRepository.findById(data.workerId);

    if (workerResult.isFailure) {
      return Result.fail<Worker>(workerResult.error!);
    }

    const worker = workerResult.getValue();
    if (!worker) {
      return Result.fail<Worker>('Worker not found');
    }

    // Resolve o telefone a persistir.
    //
    // A coluna `workers.phone` (plaintext) tem índice único parcial
    // (idx_workers_phone_unique). Como a base tem workers duplicados pelo mesmo
    // número em formatos históricos diferentes, gravar o telefone cru aqui
    // causava `duplicate key value violates unique constraint` ao completar o
    // perfil — mesmo quando o worker não estava trocando o número, só fazendo
    // round-trip do valor já armazenado num formato distinto.
    //
    // Regra:
    //  - Normaliza o número recebido e o atual para o formato canônico (549...).
    //  - Se forem iguais (round-trip) OU o recebido for vazio: NÃO toca no phone
    //    (mantém o valor atual via COALESCE no repo) → caso comum, nunca colide.
    //  - Se houve troca real: garante que o número não pertence a outro worker.
    //    Se pertencer, bloqueia com código estável (mensagem amigável definida
    //    na borda) — sem revelar que o número está em outra conta.
    const phoneToPersist = await this.resolvePhoneToPersist(data.workerId, data.phone, worker.phone);
    if (phoneToPersist.isFailure) {
      return Result.fail<Worker>(phoneToPersist.error!);
    }

    const updateResult = await this.workerRepository.updatePersonalInfo({
      workerId: data.workerId,
      firstName: data.firstName,
      lastName: data.lastName,
      sex: data.sex,
      gender: data.gender,
      birthDate: data.birthDate,
      documentType: data.documentType,
      documentNumber: data.documentNumber,
      phone: phoneToPersist.getValue(),
      profilePhotoUrl: data.profilePhotoUrl,
      languages: data.languages,
      profession: data.profession,
      knowledgeLevel: data.knowledgeLevel,
      titleCertificate: data.titleCertificate,
      experienceTypes: data.experienceTypes,
      yearsExperience: data.yearsExperience,
      preferredTypes: data.preferredTypes,
      preferredAgeRange: data.preferredAgeRange,
      termsAccepted: data.termsAccepted === true,
      privacyAccepted: data.privacyAccepted === true,
    });

    if (updateResult.isFailure) {
      return updateResult;
    }

    await this.workerRepository.recalculateStatus(data.workerId);

    return Result.ok<Worker>(updateResult.getValue());
  }

  /**
   * Decide o valor de `phone` a gravar.
   *
   * Retorna string vazia quando o telefone NÃO deve ser alterado (round-trip do
   * próprio número ou entrada vazia) — o repositório usa COALESCE e mantém o
   * valor atual. Retorna o número canônico quando há troca real e válida.
   * Falha com PHONE_NOT_AVAILABLE quando o número (normalizado) já pertence a
   * outro worker.
   */
  private async resolvePhoneToPersist(
    workerId: string,
    incomingPhone: string | undefined,
    currentPhone: string | undefined,
  ): Promise<Result<string>> {
    const incomingNorm = normalizePhoneAR(incomingPhone);

    // Entrada vazia ou número inalterado → mantém o valor atual (não colide).
    if (!incomingNorm || incomingNorm === normalizePhoneAR(currentPhone)) {
      return Result.ok<string>('');
    }

    // Troca real: o número não pode pertencer a outro worker.
    const candidates = generatePhoneCandidates(incomingPhone ?? '');
    const ownerResult = await this.workerRepository.findByPhoneCandidates(candidates);
    if (ownerResult.isFailure) {
      return Result.fail<string>(ownerResult.error!);
    }
    const owner = ownerResult.getValue();
    if (owner && owner.id !== workerId) {
      return Result.fail<string>(WORKER_ERROR_CODES.PHONE_NOT_AVAILABLE);
    }

    return Result.ok<string>(incomingNorm);
  }
}
