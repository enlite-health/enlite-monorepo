/**
 * livenessGuard — separa "registro velho" de "pessoa viva".
 *
 * Nasceu do incidente de 10/08/2026: um arquivamento em massa desativou 5.169
 * workers e aplicou opt-out formal (Ley 25.326). A régua olhava só atributos do
 * REGISTRO (`encuadres.recruitment_date`, `source` da postulação) e não olhava
 * nada da PESSOA. Resultado: gente que tinha criado conta e logado no app dias
 * antes foi silenciada, porque a linha dela vinha de uma planilha antiga.
 *
 * A medição que fechou o diagnóstico: dos 3.881 que seguiam desativados, 3.745
 * NÃO TINHAM CONTA no Identity Platform (o `auth_uid` no nosso banco é órfão da
 * importação) — mas 136 tinham, e 23 haviam logado nos últimos 30 dias.
 * Existência de conta + último login é o que separa registro de pessoa.
 *
 * Este módulo é puro na decisão e isolado no I/O, para poder ser testado sem
 * rede: `isRecentLogin` decide, `fetchLastLogins` busca.
 */

/** Milissegundos por dia. */
const DAY_MS = 24 * 60 * 60 * 1000;

export interface LoginRecord {
  /** uid no Identity Platform. */
  uid: string;
  /**
   * Último login em epoch-ms, ou null quando a conta existe mas nunca logou.
   * Ausência do uid no mapa = conta NÃO EXISTE (uid órfão do import).
   */
  lastLoginAtMs: number | null;
}

/**
 * Decide se um uid conta como "vivo" dentro da janela.
 *
 * Regras, e o porquê de cada uma:
 *  - uid ausente do mapa → conta não existe → NÃO é vivo (é o caso dos 3.745).
 *  - conta existe mas nunca logou → NÃO é vivo.
 *  - login dentro da janela → VIVO (protegido do arquivamento).
 *  - `now` é injetado para o teste não depender do relógio.
 */
export function isRecentLogin(
  uid: string | null,
  logins: Map<string, number | null>,
  windowDays: number,
  now: number,
): boolean {
  if (!uid) return false;
  if (!logins.has(uid)) return false;
  const last = logins.get(uid) ?? null;
  if (last === null) return false;
  return now - last <= windowDays * DAY_MS;
}

/**
 * Busca o último login de cada uid no Identity Platform.
 *
 * Falha FECHADA por decisão: se a consulta quebrar, propaga o erro em vez de
 * devolver mapa vazio. Mapa vazio significaria "ninguém está vivo", e o script
 * chamador arquivaria todo mundo — exatamente o acidente que este guard existe
 * para impedir. Um lote que não roda é recuperável; um opt-out em massa não é.
 */
export async function fetchLastLogins(
  uids: string[],
  getUsers: (batch: string[]) => Promise<LoginRecord[]>,
  batchSize = 100,
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  for (let i = 0; i < uids.length; i += batchSize) {
    const batch = uids.slice(i, i + batchSize);
    const found = await getUsers(batch);
    for (const rec of found) out.set(rec.uid, rec.lastLoginAtMs);
  }
  return out;
}
