/**
 * Estado da extensão do Tactiq por operadora (spec 050 F15, R-1/R-2). Função pura sobre o que o relatório do Chrome devolve.
 *
 *  - `sem_relatorio`: o Google não tem relatório utilizável (sem perfil, nunca reportou, relatório com mais de 48 h, ou dados que se
 *    contradizem). NÃO revoga e NÃO libera ninguém (R-2).
 *  - `ausente`: relatório fresco, e a extensão não está lá. `desativada`: está, mas a pessoa a desligou. `instalada`: está e ativa.
 *
 * `instalada` NÃO é "apta": o relatório não enxerga login na conta errada, perfil pessoal, outro navegador nem celular (§3.4).
 * Este módulo não decide aptidão e nada aqui a concede.
 */
import type { ChromeProfileReport } from '../application/ports/ChromeReportPort';

export type ExtensionState = 'sem_relatorio' | 'ausente' | 'desativada' | 'instalada';
/** Os estados que dizem algo sobre a extensão (os que geram evento e aviso por transição). */
export type ConclusiveExtensionState = Exclude<ExtensionState, 'sem_relatorio'>;

/** Relatório com mais de 48 h (estritamente maior) é `sem_relatorio` (R-2). */
export const REPORT_MAX_AGE_HOURS = 48;

export function isConclusive(state: ExtensionState): state is ConclusiveExtensionState {
  return state !== 'sem_relatorio';
}

export interface ClassifyInput {
  profile: ChromeProfileReport | null;
  /** A pessoa aparece em `findInstalledAppProfiles`? */
  inInstalledList: boolean;
  extensionId: string;
  now: Date;
}

export interface ExtensionObservation {
  state: ExtensionState;
  /** `relatorio_de`: o `lastStatusReportTime` que sustentou o estado (`null` quando não há). */
  reportAt: Date | null;
}

export function classifyExtension(input: ClassifyInput): ExtensionObservation {
  const { profile, now } = input;
  const reportAt = profile?.lastStatusReportTime ?? null;
  if (!profile || !reportAt || Number.isNaN(reportAt.getTime())) return { state: 'sem_relatorio', reportAt: null };
  const ageHours = (now.getTime() - reportAt.getTime()) / 3_600_000;
  if (ageHours > REPORT_MAX_AGE_HOURS) return { state: 'sem_relatorio', reportAt };

  const ext = profile.extensions.find((e) => e.extensionId === input.extensionId);
  if (ext) return { state: ext.isDisabled ? 'desativada' : 'instalada', reportAt };
  // O perfil não lista a extensão, mas a lista de instalações lista a pessoa: dois relatórios que se contradizem não provam nada.
  if (input.inInstalledList) return { state: 'sem_relatorio', reportAt };
  return { state: 'ausente', reportAt };
}
