/**
 * Porta do relatório do Chrome (spec 050 F15, §3.3): "a extensão do Tactiq está instalada e ativa no Chrome gerenciado da operadora?".
 *
 * Contrato fixado pelas 3 referências do §16 (Chrome Management API; Chrome Policy API):
 *  - `reports:findInstalledAppProfiles` → quem tem o app (por perfil gerenciado);
 *  - `profiles` (filtro `userEmail`) → `reportingData.extensionData[]` (`extensionId`, `isDisabled`) + `lastStatusReportTime`;
 *  - `reports:countInstalledApps` → o CONTROLE (`profileCount`);
 *  - `chromepolicy policies:resolve` → a instalação forçada segue aplicada.
 *
 * Nesta fase a porta só existe DUBLADA: o adaptador real não tem implementação de rede (a API só é liberada pelo super admin na F18).
 * Regra transversal: nenhum erro desta camada carrega e-mail, id de perfil/dispositivo nem corpo de resposta do Google — só `reason` fechado.
 */

/** Id da extensão do Tactiq na Chrome Web Store (spec §3.3). */
export const TACTIQ_EXTENSION_ID = 'fggkaccpbmombhnjkjokndojfgagejfb';

/** O adaptador real foi pedido com NODE_ENV=test: teste nunca toca o Google. */
export class ChromeReportRealClientInTestError extends Error {
  readonly code = 'CHROME_REPORT_REAL_CLIENT_IN_TEST';
  constructor(what: string) {
    super(`${what}: o cliente REAL do relatório do Chrome não pode ser instanciado com NODE_ENV=test`);
    this.name = 'ChromeReportRealClientInTestError';
  }
}

/** A API real ainda não foi liberada (F18): o adaptador real não chama rede. O job devolve "indisponível", sem tocar estado. */
export class ChromeReportNotReleasedError extends Error {
  readonly code = 'CHROME_REPORT_NOT_RELEASED';
  constructor() {
    super('chrome_report_not_released');
    this.name = 'ChromeReportNotReleasedError';
  }
}

/** Falha que não prova nada sobre as operadoras (rede, 5xx, escopo): o job falha alto e não grava estado. */
export class ChromeReportTransientError extends Error {
  readonly code = 'CHROME_REPORT_TRANSIENT';
  constructor(readonly reason: string) {
    super(`chrome_report_transient:${reason}`);
    this.name = 'ChromeReportTransientError';
  }
}

/** R-2: a lista veio vazia mas o controle (`countInstalledApps`) diz que há instalações — NUNCA vira "ninguém tem". */
export class ChromeReportEmptyListError extends Error {
  readonly code = 'CHROME_REPORT_EMPTY_LIST';
  constructor(readonly profileCount: number) {
    super('chrome_report_empty_list');
    this.name = 'ChromeReportEmptyListError';
  }
}

export interface ChromeProfileReport {
  /** `lastStatusReportTime` do perfil; `null` = o perfil nunca reportou. */
  lastStatusReportTime: Date | null;
  /** `reportingData.extensionData[]` reduzido ao que importa. */
  extensions: Array<{ extensionId: string; isDisabled: boolean }>;
}

/** Valor resolvido da política de instalação forçada. `unknown` = o nome do esquema não foi medido (spec §3.3 [NÃO MEDIDO]). */
export type ForcedInstallPolicy = 'applied' | 'absent' | 'unknown';

export interface ChromeReportPort {
  /** `findInstalledAppProfiles`: e-mails (minúsculos) dos perfis gerenciados com o app. Só e-mail; nada de id de perfil. */
  findInstalledEmails(appId: string): Promise<string[]>;
  /** `profiles` filtrado por `userEmail`. `null` = o Google não tem perfil reportando para esta pessoa. */
  getProfile(email: string): Promise<ChromeProfileReport | null>;
  /** `countInstalledApps.profileCount`: o controle da lista. */
  countInstalledProfiles(appId: string): Promise<number>;
  /** `policies:resolve` para o app. */
  resolveForcedInstall(appId: string): Promise<ForcedInstallPolicy>;
}
