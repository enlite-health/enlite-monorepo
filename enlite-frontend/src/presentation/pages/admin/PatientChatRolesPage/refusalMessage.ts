import { PatientApiError } from '@infrastructure/http/AdminPatientsApiService';

type Translate = (key: string, opts?: Record<string, unknown>) => string;

/**
 * Traduz a recusa do backend PRESERVANDO o número.
 *
 * O servidor responde em inglês ("Chat role is in use by 21 patient(s)") e quem
 * opera o painel lê es-AR ou pt-BR. Mas o payload traz `code` + `details` com a
 * CONTAGEM, então dá para ter as duas coisas: a frase no idioma da pessoa e o
 * número — que é o que decide o que ela faz em seguida, e por isso nunca pode
 * se perder na tradução.
 *
 * Código que a tela não conhece cai na mensagem do servidor: inglês é melhor
 * que erro engolido, e uma recusa nova do backend nunca fica invisível.
 */
export function refusalMessage(err: unknown, t: Translate): string {
  if (err instanceof PatientApiError && err.code) {
    const key = `admin.patientChatRoles.errors.${err.code}`;
    const d = (err.details ?? {}) as Record<string, number>;
    const translated = t(key, {
      count: d.patientCount ?? 0,
      groupCount: d.groupCount ?? 0,
      patientCount: d.patientCount ?? 0,
    });
    if (translated !== key) return translated;
  }
  return err instanceof Error ? err.message : String(err);
}
