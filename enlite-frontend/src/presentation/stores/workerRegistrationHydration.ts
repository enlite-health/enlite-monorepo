import type { WorkerProgressResponse } from '@infrastructure/http/WorkerApiService';

/**
 * Tradução `WorkerProgressResponse` (API) → forma do store/formulário.
 *
 * Extraído de `workerRegistrationStore.ts` para manter o store dentro do teto
 * de 400 linhas, e porque a regra de precedência (servidor × local) merece
 * ficar isolada e testável.
 */

/**
 * Precedência entre o valor do servidor e o que já está no store.
 *
 * `authoritative: false` (carregamento de tela, `GET /progress`): o local vence
 * quando o servidor devolve vazio. Protege edição ainda não salva — foi o
 * conserto do "campo aparece e some" de 29/06/2026.
 *
 * `authoritative: true` (DEPOIS de uma escrita): a resposta É o estado, então
 * campo ausente vira VAZIO. Sem isso, um valor que o banco não gravou continua
 * na tela e no localStorage: foi assim que um telefone nunca persistido seguiu
 * aparecendo para a prestadora enquanto o sistema recusava a postulação por
 * falta dele (incidente 08/09/2026, 129 cadastros travados).
 */
export interface HydrationOptions {
  authoritative?: boolean;
}

type GeneralInfoShape = {
  email: string;
  fullName: string;
  lastName: string;
  phone: string;
  birthDate: string;
  sex: string;
  gender: string;
  documentType: string;
  cpf: string;
  languages: string[];
  profession: string;
  knowledgeLevel: string;
  professionalLicense: string;
  experienceTypes: string[];
  yearsExperience: string;
  preferredTypes: string[];
  preferredAgeRange: string[];
  profilePhoto: string | null;
};

type ServiceAddressShape = {
  address: string;
  complement: string;
  serviceRadius: number;
};

function pickers(authoritative: boolean) {
  const str = (server: string | undefined, local: string): string =>
    authoritative ? (server ?? '') : (server || local);
  const arr = <T>(server: T[] | undefined, local: T[]): T[] =>
    authoritative ? (server ?? []) : (server?.length ? server : local);
  return { str, arr };
}

/** Mescla os campos gerais vindos do servidor sobre o que já está no store. */
export function mergeGeneralInfo<T extends GeneralInfoShape>(
  serverData: WorkerProgressResponse,
  local: T,
  options?: HydrationOptions,
): T {
  const { str, arr } = pickers(options?.authoritative === true);

  const preferredAgeRange = Array.isArray(serverData.preferredAgeRange)
    ? serverData.preferredAgeRange
    : serverData.preferredAgeRange
      ? [serverData.preferredAgeRange]
      : arr(undefined, local.preferredAgeRange);

  return {
    ...local,
    email: serverData.email,
    fullName: str(serverData.firstName, local.fullName),
    lastName: str(serverData.lastName, local.lastName),
    phone: str(serverData.phone, local.phone),
    birthDate: str(serverData.birthDate, local.birthDate),
    sex: str(serverData.sex, local.sex),
    gender: str(serverData.gender, local.gender),
    documentType: str(serverData.documentType, local.documentType),
    cpf: str(serverData.documentNumber, local.cpf),
    languages: arr(serverData.languages, local.languages),
    profession: str(serverData.profession, local.profession),
    knowledgeLevel: str(serverData.knowledgeLevel, local.knowledgeLevel),
    professionalLicense: str(serverData.titleCertificate, local.professionalLicense),
    experienceTypes: arr(serverData.experienceTypes, local.experienceTypes),
    yearsExperience: str(serverData.yearsExperience, local.yearsExperience),
    preferredTypes: arr(serverData.preferredTypes, local.preferredTypes),
    preferredAgeRange,
    // Foto tem semântica própria (apagar é operação legítima na tela), então
    // não entra na regra autoritativa acima.
    profilePhoto: serverData.profilePhotoUrl || local.profilePhoto,
  };
}

/** Mescla o endereço de atendimento vindo do servidor. */
export function mergeServiceAddress<T extends ServiceAddressShape>(
  serverData: WorkerProgressResponse,
  local: T,
  options?: HydrationOptions,
): T {
  const { str } = pickers(options?.authoritative === true);

  return {
    ...local,
    address: str(serverData.serviceAddress, local.address),
    complement: str(serverData.serviceAddressComplement, local.complement),
    serviceRadius: serverData.serviceRadiusKm || local.serviceRadius,
  };
}
