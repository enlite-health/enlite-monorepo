/**
 * DiagnosisPublicView — a projeção que aplica a FRONTEIRA REQ-21 (spec 016, `2026-08-26a#REQ-21`:
 * "o código e o segmento ficam INVISÍVEIS"). `concept_code`, `concept_group` e `catalog_release`
 * NUNCA chegam ao navegador, em NENHUMA rota — o código para NO SERVIDOR. Não é "esconder no
 * CSS" (a F0 mediu que invisibilidade por folha de estilo não é invisibilidade: `6A02.Z`→`02.Z`,
 * DOM certo, tela errada, nenhum teste de texto acusou) — é a chave NÃO EXISTIR no JSON.
 *
 * Único lugar que decide o formato de resposta pública do diagnóstico — controller e o embutido
 * em `GET /patients/:id` chamam ESTA função, nunca serializam a Entity direto.
 */
import type { PatientDiagnosis } from '../domain/PatientDiagnosis';

export interface DiagnosisPublicViewItem {
  readonly id: string;
  readonly uri: string;
  readonly title: string;
  readonly isPrimary: boolean;
  readonly source: string;
  readonly active: boolean;
}

export function toDiagnosisPublicView(diagnosis: PatientDiagnosis): DiagnosisPublicViewItem {
  return {
    id: diagnosis.id,
    uri: diagnosis.conceptUri,
    title: diagnosis.conceptTitle,
    isPrimary: diagnosis.isPrimary,
    source: diagnosis.source.value,
    active: diagnosis.active,
  };
}
