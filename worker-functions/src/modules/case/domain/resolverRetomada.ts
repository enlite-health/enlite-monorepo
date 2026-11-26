/**
 * resolverRetomada — o destino de "retomar" (de `ON_HOLD`/`SUSPENDED`) e de "reativar" (de `DISCHARGED`) (estado-automatico-do-paciente,
 * F3 / D5 / D9, design §6). O cliente NUNCA escolhe: a regra de horas do itinerário decide quando pode; quando não pode (sem itinerário
 * montado, sem vaga viva, sem faixa), `SEARCHING` — mesmo que o estado anterior à pausa/baja fosse `ACTIVE` (D516: Activo só com
 * itinerário cobrindo tudo; emenda à D808). A trilha NÃO é consultada: a função recebe só as horas e é pura, sem `if` (cadeia `??`).
 */
import { derivarPelasHoras, type EntradaDerivacao } from './derivarEstadoPaciente';
import type { PatientStatus } from './enums/PatientStatus';

export const resolverRetomada = (r: { horas: EntradaDerivacao }): PatientStatus => derivarPelasHoras(r.horas) ?? 'SEARCHING';
