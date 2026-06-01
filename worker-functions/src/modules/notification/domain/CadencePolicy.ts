/**
 * CadencePolicy — define a cadência de reenvio de um template de WhatsApp.
 *
 * A cadência é expressa pelos intervalos (em dias) ENTRE envios consecutivos.
 * Ex.: `new CadencePolicy([3, 7])`
 *   - envio 1: assim que o worker fica elegível
 *   - envio 2: >= 3 dias após o envio 1
 *   - envio 3: >= 7 dias após o envio 2
 *   - cap: 3 envios (gaps.length + 1)
 *
 * Não envia em dias consecutivos — foi a ausência dessa regra que derrubou a
 * reputação no Meta (ver docs/INCIDENT_WHATSAPP_SPAM.md no triage-service).
 *
 * Em vez de filtrar em memória, a policy gera o fragmento SQL de elegibilidade
 * a partir de duas expressões já computadas pela query de seleção: o total de
 * envios e o timestamp do último envio. Assim a seleção continua no banco
 * (eficiente) e a cadência fica declarativa e reusável por outros templates.
 */
export class CadencePolicy {
  private readonly gapsDays: readonly number[];

  constructor(gapsDays: readonly number[]) {
    if (gapsDays.some(g => !Number.isInteger(g) || g < 0)) {
      throw new Error('CadencePolicy: gaps devem ser inteiros >= 0');
    }
    this.gapsDays = [...gapsDays];
  }

  /** Máximo de envios permitidos (1 inicial + 1 por gap). */
  get maxSends(): number {
    return this.gapsDays.length + 1;
  }

  /**
   * Fragmento SQL booleano de elegibilidade para o próximo envio.
   *
   * @param sentCountExpr expressão que resolve no total de envios já feitos
   *                      (ex.: `'COALESCE(ss.total_sent, 0)'`)
   * @param lastSentExpr  expressão que resolve no timestamp do último envio
   *                      (ex.: `'ss.last_sent_at'`)
   *
   * Os gaps são inteiros validados no construtor — seguros para interpolar.
   */
  toSqlEligibility(sentCountExpr: string, lastSentExpr: string): string {
    const conditions = [`${sentCountExpr} = 0`];
    this.gapsDays.forEach((gap, idx) => {
      // Após o envio nº (idx + 1), aguarda `gap` dias para liberar o próximo.
      conditions.push(
        `(${sentCountExpr} = ${idx + 1} AND ${lastSentExpr} < NOW() - INTERVAL '${gap} days')`,
      );
    });
    return `(${conditions.join(' OR ')}) AND ${sentCountExpr} < ${this.maxSends}`;
  }
}
