import { ENQUADRE_SUMMARY_PROMPT } from '../domain/prompts/enquadreSummaryPrompt';
import { assertEnquadreSummaryShape } from '../application/enquadreSummaryGate';
import type { AdmissionSummaryInput } from '../application/ports/AdmissionImportPorts';
import type { SummaryProfile } from './VertexAdmissionSummaryGenerator';

/**
 * A mensagem do usuário do resumo de encuentro: o cabeçalho de metadados (`entrevista_id` = código `ENC-`, `fecha`), a lista de
 * convocados (SÓ `ref` interna + nome, como decidiu o Gabriel em 13/10: nada de telefone, e-mail ou documento) e a transcrição.
 * Os nomes vão ao Vertex (dentro do perímetro) e a mais lugar nenhum: nem log, nem trilha.
 */
export function buildEnquadreInput(input: AdmissionSummaryInput): string {
  const head = [input.entrevistaId ? `entrevista_id=${input.entrevistaId}` : null, input.fecha ? `fecha=${input.fecha}` : null].filter(Boolean);
  const convocados = JSON.stringify((input.convocados ?? []).map((c) => ({ ref: c.ref, nombre: c.nombre })));
  return `${head.join('\n')}\n\nconvocados:\n${convocados}\n\ntranscripcion:\n${input.transcript}`;
}

/** O perfil do gerador para o ENCUADRE: prompt em arquivo (texto), sem catálogos, entrada com convocados e gate próprio. */
export const ENQUADRE_SUMMARY_PROFILE: SummaryProfile = {
  prompt: { kind: 'text', text: ENQUADRE_SUMMARY_PROMPT },
  markers: async () => ({}),
  buildInput: buildEnquadreInput,
  assertShape: assertEnquadreSummaryShape,
};
