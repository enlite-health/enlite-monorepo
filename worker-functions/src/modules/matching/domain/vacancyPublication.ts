/**
 * vacancyPublication — o DONO de "vaga publicável" (semaforo-da-vaga F4, P5 opção A + P6).
 *
 * Ninguém escolhe mais um estado para a vaga ir ao ar. Publicável =
 *   não apagada · lançada (`is_draft = false`) · não é de teste · serviço contratado não inativo ·
 *   status ∉ STATUS_QUE_TIRAM_DO_FEED (só o legado pausado/fechado e a baixa) ·
 *   paciente fora de PACIENTE_QUE_PAUSA_A_VAGA (lido por join, sem escrita).
 *
 * Leitores: feed público e busca por raio (`PublicJobsQueryBuilder`), página pública e candidatura
 * (`PublicVacancyController`), short link (`tryEnsureShortLink`), a Luz (`FindNearbyVacanciesForWorkerUseCase`) e a
 * marcação de pausa do Talentum (`semPaciente`). Lista solta de status de vaga = contrato `vacancyStatusLists`.
 *
 * A regra em TS (`vagaPublicavel`) e o SQL (`vagaPublicavelSql`) saem das MESMAS duas tabelas. Domínio puro: sem `pg`.
 */

/** Status que tiram a vaga do ar. `PENDING_ACTIVATION` NÃO está aqui: a vaga do foguete nasce publicável ao ser lançada. */
export const STATUS_QUE_TIRAM_DO_FEED = ['DE_BAJA', 'CLOSED', 'ON_HOLD', 'SUSPENDED'] as const;

/** P6: paciente nestes estados pausa a vaga dele (feed e Talentum). Retomar = sair deste conjunto. */
export const PACIENTE_QUE_PAUSA_A_VAGA = ['ON_HOLD', 'SUSPENDED', 'ALTA', 'DISCHARGED'] as const;

export interface VagaPublicacaoFatos {
  status: string;
  isDraft: boolean;
  isTest: boolean;
  deleted: boolean;
  /** `patient_contracted_services.active` do serviço da vaga; `null` = vaga sem serviço. */
  serviceActive: boolean | null;
  /** `patients.status`; `null` = vaga sem paciente. */
  patientStatus: string | null;
}

const em = (lista: readonly string[], valor: string | null): boolean => valor !== null && lista.includes(valor);

export const vagaPublicavel = (v: VagaPublicacaoFatos): boolean =>
  !v.deleted
  && !v.isDraft
  && !v.isTest
  && v.serviceActive !== false
  && !em(STATUS_QUE_TIRAM_DO_FEED, v.status)
  && !em(PACIENTE_QUE_PAUSA_A_VAGA, v.patientStatus);

const lista = (valores: readonly string[]): string => valores.map((s) => `'${s}'`).join(', ');

/**
 * A mesma regra em SQL, GERADA das tabelas acima. `jp` = alias de `job_postings`; `p` = alias de `patients` (LEFT JOIN do
 * chamador, que só é lido sem `semPaciente`). `semPaciente` omite a cláusula do paciente: é a pergunta "esta vaga ERA
 * publicável antes de o paciente pausar?", usada pela marcação de pausa/retomada do Talentum (P6, decisão 3).
 */
export function vagaPublicavelSql(
  jp = 'jp',
  p = 'p',
  opts: { semPaciente?: boolean } = {},
): string {
  const clausulas = [
    `${jp}.deleted_at IS NULL`,
    `${jp}.is_draft = false`,
    `${jp}.is_test = false`,
    `${jp}.status NOT IN (${lista(STATUS_QUE_TIRAM_DO_FEED)})`,
    // Cinto de segurança (baja-vacante-por-servico): serviço dado de baixa tira a vaga mesmo com o status defasado.
    // Vaga sem serviço não casa nenhuma linha → NOT EXISTS verdadeiro → não é excluída.
    `NOT EXISTS (SELECT 1 FROM patient_contracted_services pcs_pub WHERE pcs_pub.id = ${jp}.contracted_service_id AND pcs_pub.active = false)`,
    ...(opts.semPaciente ? [] : [`COALESCE(${p}.status, '') NOT IN (${lista(PACIENTE_QUE_PAUSA_A_VAGA)})`]),
  ];
  return `(${clausulas.join('\n         AND ')})`;
}
