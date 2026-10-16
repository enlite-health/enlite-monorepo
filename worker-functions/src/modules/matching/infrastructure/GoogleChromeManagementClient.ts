import {
  ChromeReportNotReleasedError,
  ChromeReportRealClientInTestError,
  type ChromeProfileReport,
  type ChromeReportPort,
  type ForcedInstallPolicy,
} from '../application/ports/ChromeReportPort';

/**
 * Adaptador REAL do relatório do Chrome — SEM implementação de rede nesta fase (spec 050 F15).
 *
 * A Chrome Management API só é liberada pelo super admin no pedido único da F18. Até lá este adaptador não importa `googleapis`,
 * não chama `fetch` e não lê credencial: toda chamada rejeita com `ChromeReportNotReleasedError`, e o job devolve "indisponível"
 * sem tocar estado nem ninguém. A F18 troca o corpo dos 4 métodos; a porta e o job não mudam.
 *
 * ⚠️ Lança no construtor com NODE_ENV=test: teste nunca toca o Google.
 */
export class GoogleChromeManagementClient implements ChromeReportPort {
  constructor(env: NodeJS.ProcessEnv = process.env) {
    if (env.NODE_ENV === 'test') throw new ChromeReportRealClientInTestError('new GoogleChromeManagementClient()');
  }

  findInstalledEmails(): Promise<string[]> {
    return Promise.reject(new ChromeReportNotReleasedError());
  }

  getProfile(): Promise<ChromeProfileReport | null> {
    return Promise.reject(new ChromeReportNotReleasedError());
  }

  countInstalledProfiles(): Promise<number> {
    return Promise.reject(new ChromeReportNotReleasedError());
  }

  resolveForcedInstall(): Promise<ForcedInstallPolicy> {
    return Promise.reject(new ChromeReportNotReleasedError());
  }
}
