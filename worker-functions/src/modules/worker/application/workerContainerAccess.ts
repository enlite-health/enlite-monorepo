/**
 * workerContainerAccess — o ÚNICO ponto que decide, container a container, o que da FICHA de um
 * prestador um ator recebe (D286 fase 2, 06/09/2026 — o mesmo desenho de `patientContainerAccess`).
 *
 * Até aqui `GET /workers/:id` exigia `worker_pii:read` para a tela inteira e descriptografava
 * tudo antes de qualquer decisão. Com a D286 a rota exige só o operacional (`worker:read`) e a
 * resposta é PROJETADA pelas células do ator — os três níveis que a C3 da F2 já separou em
 * `projectWorkerFields` (telefone e raça não compartilham chave: Ley 25.326 arts. 2 e 7.3; LGPD
 * art. 6 III), mais dois blocos que a ficha anexa:
 *
 *  · `worker:read`           id, status, profissão, ocupação, experiência, preferências, idiomas,
 *                            zonas (cidade, zona de trabalho, raio, lat/lng — o mapa `/admin/mapa`
 *                            já os expõe sob esta célula), disponibilidade, etiquetas, conta de teste
 *  · `worker_contact:read`   nome, e-mail, telefone, whatsapp, linkedin      → container `contact`
 *  · `worker_pii:read`       DNI, nascimento, sexo, gênero, foto, raça, religião, orientação
 *                            sexual, peso, altura, ENDEREÇO (linha de endereço) → `dossier`
 *  · `worker_document:read`  o bloco `documents` (URLs assinadas só nascem com a célula) → `documents`
 *  · `match:read`            o bloco `encuadres` (vagas em que o prestador está) → `encuadres`
 *
 * Dentro de `encuadres[]` viaja o NOME DO PACIENTE da vaga — dado de outro titular. Ele segue a
 * célula de identidade do paciente (`patient_identity:read`, D286 fase 1), não a do prestador.
 *
 * ── `cells = null` NÃO é "nenhuma célula" ───────────────────────────────────────────────────
 * É "o engine não decidiu nesta request" (família fora de `PERMISSION_ENFORCED_ROUTES`, principal
 * de serviço como a Luz em `by-phone`, engine desligado). Nesse estado tudo passa, como a rota
 * devolvia antes (D113). `[]` é ator conhecido e sem célula → redige tudo que não for operacional.
 *
 * ── A regra da C3 continua: a célula decide ANTES de o KMS rodar ────────────────────────────
 * O builder da ficha só chama `decrypt` no ramo autorizado; a prova é o espião com 0 chamadas
 * (`__tests__/AdminWorkersDetailBuilder.test.ts`), não uma leitura do código.
 *
 * ── Marcador de redação CONSTANTE ───────────────────────────────────────────────────────────
 * `redacted.<container> = true` sai SEMPRE que falta a célula, com ou sem conteúdo — senão
 * "tem documento" / "está em alguma vaga" vazaria por inferência (LGPD art. 11 §5).
 */

import { cellKey } from '@modules/identity/permissions/domain/PermissionCell';
import { NOME_REDIGIDO } from '@modules/identity/permissions/application/projectWorkerFields';
import { canReadPatientContainer } from '@modules/case/application/patientContainerAccess';

export const WORKER_CONTAINERS = ['contact', 'dossier', 'documents', 'encuadres'] as const;
export type WorkerContainer = (typeof WORKER_CONTAINERS)[number];

/** Recurso (o `resource` da célula `recurso:ação`) de cada container. */
export const WORKER_CONTAINER_RESOURCE: Readonly<Record<WorkerContainer, string>> = {
  contact: 'worker_contact',
  dossier: 'worker_pii',
  documents: 'worker_document',
  encuadres: 'match',
};

export const workerContainerCell = (container: WorkerContainer): string =>
  cellKey(WORKER_CONTAINER_RESOURCE[container], 'read');

/** Que containers o ator pode LER. `null` (engine não decidiu) → todos. */
export type WorkerContainerReads = Readonly<Record<WorkerContainer, boolean>> & {
  /** O nome do paciente dentro de `encuadres[]` — célula do OUTRO titular. */
  readonly patientIdentity: boolean;
};

export function canReadWorkerContainer(cells: readonly string[] | null | undefined, container: WorkerContainer): boolean {
  if (cells === null || cells === undefined) return true;
  return cells.includes(workerContainerCell(container));
}

export function workerContainerReadsOf(cells: readonly string[] | null | undefined): WorkerContainerReads {
  const out = {} as Record<WorkerContainer, boolean> & { patientIdentity: boolean };
  for (const c of WORKER_CONTAINERS) out[c] = canReadWorkerContainer(cells, c);
  out.patientIdentity = canReadPatientContainer(cells, 'identity');
  return out;
}

export const ALL_WORKER_CONTAINERS_READABLE: WorkerContainerReads = workerContainerReadsOf(null);

/** Os containers efetivamente SERVIDOS nesta resposta — o que a trilha registra. */
export function servedWorkerContainers(cells: readonly string[] | null | undefined): WorkerContainer[] {
  const reads = workerContainerReadsOf(cells);
  return WORKER_CONTAINERS.filter((c) => reads[c]);
}

/**
 * O marcador de redação para a resposta — `undefined` quando nada foi redigido, para a resposta
 * de quem lê tudo ser byte a byte a de antes (D113).
 */
export function workerRedactionMarker(reads: WorkerContainerReads): Partial<Record<WorkerContainer, true>> | undefined {
  const hidden = WORKER_CONTAINERS.filter((c) => !reads[c]);
  if (hidden.length === 0) return undefined;
  const out: Partial<Record<WorkerContainer, true>> = {};
  for (const c of hidden) out[c] = true;
  return out;
}

/**
 * O nome do paciente numa linha de encuadre, projetado pela célula de identidade do paciente.
 * Sem ela vem `NOME_REDIGIDO`, nunca vazio: vazio some da tela e a pessoa acha que a vaga está
 * sem paciente (a mesma razão da C3 para o nome do prestador no Kanban).
 */
export function projectPatientNameInEngagement(name: string | null, reads: WorkerContainerReads): string | null {
  return reads.patientIdentity ? name : NOME_REDIGIDO;
}
