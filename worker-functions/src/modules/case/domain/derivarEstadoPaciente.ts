/**
 * derivarEstadoPaciente — a regra de horas do quadro A, por PACIENTE (cadeia Fase 15, DX-15.6).
 *
 * A regra (D427, `#DEC-02`, `#REGRA-03`): com o itinerário montado, zero horas cobertas → búsqueda
 * (`SEARCHING`); todo serviço com vacante viva cheio → activo (`ACTIVE`); senão → reemplazo
 * (`REPLACEMENT`), decidido pelo paciente inteiro, nunca por serviço.
 *
 * - Só alocar move (`#REGRA-37`): selecionar, Equipe de Resposta Rápida e o quadro C não mudam horas,
 *   então não mudam o resultado.
 * - Sem itinerário montado não deriva (D429).
 * - Não conta ausência/substituição datada (invariante 9): a entrada é a cobertura SEMANAL da conta
 *   da Fase 7 (`buildServiceCoverages`), e `contratadas` é o `contratadas.weekly` dela.
 * - Estado manual e funil de admissão nunca são tocados; serviço sem vacante viva não conta.
 *
 * Função pura: sem I/O, sem relógio. `null` = não mexe. A derivação que escreve é
 * `PatientStatusDerivation`, sempre por `movePatientStatus`.
 *
 * A ordem das guardas é load-bearing: cada uma é a ÚNICA barreira do seu caso (as sabotagens da
 * fase dependem disso) — por isso não há lista de "deriváveis" antes delas.
 */
import {
  ADMISSION_FUNNEL_STATUSES,
  isPatientStatus,
  type PatientStatus,
} from './enums/PatientStatus';

export interface ServicoParaDerivar {
  temVacanteViva: boolean;
  cobertas: number;
  contratadas: number | null;
}

export interface EntradaDerivacao {
  status: string | null;
  montado: boolean;
  servicos: readonly ServicoParaDerivar[];
}

/** Estados manuais (D430): en espera, suspendido temporalmente, alta, baja. */
export const MANUAIS: readonly PatientStatus[] = ['ON_HOLD', 'SUSPENDED', 'ALTA', 'DISCHARGED'] as const;

/** Coluna "admisión": sai dela só no lançamento (Fase 5, invariante 7). */
export const FUNIL = ADMISSION_FUNNEL_STATUSES;

export function derivarEstadoPaciente(e: EntradaDerivacao): PatientStatus | null {
  const { status } = e;
  // (1) fora do vocabulário (inclui `null` e `DISCONTINUED`)
  if (!isPatientStatus(status)) return null;
  // (2) estado manual
  if (MANUAIS.includes(status)) return null;
  // (3) funil de admissão
  if ((FUNIL as readonly string[]).includes(status)) return null;
  // (4) itinerário não montado (D429)
  if (!e.montado) return null;
  // (5) só serviço com vacante viva conta
  const vivos = e.servicos.filter((s) => s.temVacanteViva);
  if (vivos.length === 0) return null;
  // (6) sem régua de total (Q-15.3): não há "cheio"
  if (vivos.some((s) => s.contratadas === null)) return null;
  // (7) zero horas cobertas no paciente
  const total = vivos.reduce((soma, s) => soma + s.cobertas, 0);
  if (total === 0) return 'SEARCHING';
  // (8) todo serviço cheio
  if (vivos.every((s) => s.cobertas >= (s.contratadas as number))) return 'ACTIVE';
  // (9) por paciente
  return 'REPLACEMENT';
}
