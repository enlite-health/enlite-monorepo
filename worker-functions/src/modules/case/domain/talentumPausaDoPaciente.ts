/**
 * talentumPausaDoPaciente — a tabela "a transição de `patients.status` pausa ou retoma as vagas dele no Talentum?"
 * (semaforo-da-vaga F4, P6 / decisão 2). O CONJUNTO que pausa é o do dono (`PACIENTE_QUE_PAUSA_A_VAGA`, `vacancyPublication.ts`):
 * o feed lê o estado do paciente por join e segue sozinho; o Talentum precisa de uma marcação, e ela nasce na transição.
 *
 *   vivo → pausado   = pause     pausado → vivo = resume
 *   vivo → vivo      = nada      pausado → pausado (ON_HOLD → SUSPENDED) = nada (já está pausado)
 *
 * Tabela, sem `if` por estado. Domínio puro.
 */
import { PACIENTE_QUE_PAUSA_A_VAGA } from '../../matching/domain/vacancyPublication';

export type AcaoTalentum = 'pause' | 'resume';

const PAUSA: ReadonlySet<string> = new Set(PACIENTE_QUE_PAUSA_A_VAGA);
const pausado = (status: string | null): boolean => status !== null && PAUSA.has(status);

const ACAO_POR_TRANSICAO: Readonly<Record<`${boolean}>${boolean}`, AcaoTalentum | null>> = {
  'false>true': 'pause',
  'true>false': 'resume',
  'false>false': null,
  'true>true': null,
};

export const acaoTalentumDaTransicao = (from: string | null, to: string): AcaoTalentum | null =>
  ACAO_POR_TRANSICAO[`${pausado(from)}>${pausado(to)}`];
