/**
 * profileLayout — a régua de alinhamento da página Perfil (uma só, para a grade e os cartões concordarem).
 *
 * Grade da página: 2 colunas IGUAIS a partir de `xl` (viewport ≥ 1280px), gap-6 (24px) nos dois eixos; cartões com
 * padding `p-8` (32px) a partir de `sm`. Cartões de largura total dividem o interior em duas METADES iguais, e o vão
 * entre elas vale `gap da grade + 2 × padding` = 1.5rem + 2×2rem = 5.5rem (88px). É esse valor que faz a metade
 * direita começar no MESMO x em que começa o texto do cartão da coluna direita da grade, e que põe o centro do vão
 * (onde cai o filete vertical do Tactiq) no centro exato do vão entre as colunas. Mudar gap ou padding exige mudar aqui.
 */
export const HALVES_GRID = 'grid grid-cols-1 gap-y-5 xl:grid-cols-[1fr_5.5rem_1fr] xl:gap-y-0';
