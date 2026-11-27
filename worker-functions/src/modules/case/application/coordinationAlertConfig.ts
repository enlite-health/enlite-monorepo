/** Config do alerta à coordenação (emenda 077 §5.3). Env ausente ou inválida = o default da emenda. */
export interface CoordinationAlertConfig {
  /** `PRESENCE_OPEN_ALERT_AFTER_MIN`: minutos depois do fim previsto em que uma presença `OPEN` vira alerta (240). */
  presenceOpenAfterMin: number;
  /** `REFUSED_CHECKIN_ALERT_AFTER_MIN`: minutos depois da 1ª recusa sem entrada aceita (60). */
  refusedCheckInAfterMin: number;
  /** `PRESENCE_ALERT_LOOKBACK_DAYS`: quantos dias para trás o detector olha (3): cobre uma pane do Scheduler sem reabrir o passado. */
  lookbackDays: number;
}

const positive = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

export function coordinationAlertConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CoordinationAlertConfig {
  return {
    presenceOpenAfterMin: positive(env.PRESENCE_OPEN_ALERT_AFTER_MIN, 240),
    refusedCheckInAfterMin: positive(env.REFUSED_CHECKIN_ALERT_AFTER_MIN, 60),
    lookbackDays: positive(env.PRESENCE_ALERT_LOOKBACK_DAYS, 3),
  };
}
