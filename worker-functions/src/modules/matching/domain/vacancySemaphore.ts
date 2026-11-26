/**
 * vacancySemaphore — o DONO da cor do semáforo da vaga (semaforo-da-vaga, F1, D811).
 *
 * `n` = quantos prestadores ocupam a vaga (fragmento SQL `semaforoContagemSql`, infraestrutura). A COR sai
 * da tabela `FAIXAS_DO_SEMAFORO`: nenhum número de faixa mora fora dela, e a versão SQL (`corDoSemaforoSql`)
 * é GERADA da mesma tabela (molde `cicloDeVidaSql`). Zero `if` por faixa; zero `pg` (domínio).
 */

export const CORES = ['red', 'yellow', 'green'] as const;
export type CorDoSemaforo = (typeof CORES)[number];

export interface FaixaDoSemaforo {
  readonly cor: CorDoSemaforo;
  /** inclusivo */
  readonly de: number;
  /** exclusivo; `null` = sem teto (a última faixa) */
  readonly ate: number | null;
}

/** Em ordem crescente de `de`; cada faixa começa onde a anterior termina. */
export const FAIXAS_DO_SEMAFORO: readonly FaixaDoSemaforo[] = [
  { cor: 'red', de: 0, ate: 5 },
  { cor: 'yellow', de: 5, ate: 10 },
  { cor: 'green', de: 10, ate: null },
];

const dentroDaFaixa = (n: number, f: FaixaDoSemaforo): boolean => n >= f.de && (f.ate === null || n < f.ate);

/** Busca na tabela. `n` abaixo de todas as faixas (negativo) cai na primeira: contagem nunca é negativa. */
export const corDoSemaforo = (n: number): CorDoSemaforo =>
  (FAIXAS_DO_SEMAFORO.find((f) => dentroDaFaixa(n, f)) ?? FAIXAS_DO_SEMAFORO[0]).cor;

/** Versão SQL, GERADA da tabela. `nExpr` = expressão inteira de `n`. Um `WHEN` por faixa. */
export function corDoSemaforoSql(nExpr: string): string {
  const whens = FAIXAS_DO_SEMAFORO.map((f) => {
    const teto = f.ate === null ? '' : ` AND ${nExpr} < ${f.ate}`;
    return `WHEN ${nExpr} >= ${f.de}${teto} THEN '${f.cor}'`;
  });
  return `(CASE ${whens.join(' ')} END)`;
}

/** Quanto maior, pior. Record exaustivo: cor nova sem gravidade não compila. */
export const GRAVIDADE_DA_COR: Readonly<Record<CorDoSemaforo, number>> = {
  green: 0,
  yellow: 1,
  red: 2,
};

/** A pior cor da lista; lista vazia -> `null` ("sem vaga", nunca verde). */
export const piorCor = (cores: readonly CorDoSemaforo[]): CorDoSemaforo | null =>
  cores.reduce<CorDoSemaforo | null>(
    (pior, c) => (pior === null || GRAVIDADE_DA_COR[c] > GRAVIDADE_DA_COR[pior] ? c : pior),
    null,
  );
