/**
 * Guarda compartilhada contra vazamento de dado clínico — o helper existe
 * porque o defeito reincidiu TRÊS vezes no mesmo PR, cada vez num caminho
 * diferente, e cada conserto foi da instância e não da classe:
 *
 *   1ª  `utm_content` no `ShortLinkService`           → consertado
 *   2ª  o mesmo, inline no `VacancySocialLinksController` → passou 4359 testes verdes
 *   3ª  o mesmo, via `EnsureVacancyShortLinkUseCase`   → passou 4381 testes verdes
 *
 * O padrão do erro é sempre o mesmo: a guarda afirmava sobre os campos que o
 * autor IMAGINOU, com uma fixture que não carregava dado clínico nenhum. Basta
 * um parâmetro opcional novo que só emite quando presente para tudo ficar verde.
 *
 * A regra que este arquivo impõe:
 *   · a fixture SEMPRE carrega texto clínico real;
 *   · a asserção é sobre TUDO que atravessa a fronteira — URL, corpo, headers,
 *     título, argumentos de query e o que foi para o log — nunca sobre a lista
 *     de campos que alguém lembrou de checar.
 *
 * Todo caminho novo que fale com terceiro deve usar `esperaSemVazamentoClinico`.
 */

/** Texto livre no formato real do campo (`patients.diagnosis` é TEXT). */
export const TEXTO_CLINICO = 'Alzheimer moderado + diabetes tipo II, requiere asistencia total';

/** Fragmentos que não podem aparecer nem isolados (repasse parcial ou truncado). */
const FRAGMENTOS = ['Alzheimer', 'diabetes', 'asistencia total'];

/**
 * Falha se qualquer coisa entre as fornecidas contiver dado clínico.
 * Aceita qualquer valor: string, objeto, array de argumentos de mock.
 */
export function esperaSemVazamentoClinico(...coisas: unknown[]): void {
  const tudo = coisas
    .map((c) => {
      if (typeof c === 'string') return c;
      try { return JSON.stringify(c); } catch { return String(c); }
    })
    .join('\n');

  for (const f of [TEXTO_CLINICO, ...FRAGMENTOS]) {
    if (tudo.toLowerCase().includes(f.toLowerCase())) {
      throw new Error(
        `VAZAMENTO CLÍNICO: "${f}" atravessou a fronteira.\n` +
        `O que saiu:\n${tudo.slice(0, 2000)}`,
      );
    }
  }
}

/** Falha se algum SQL executado tocar em dado clínico — inclui a 2ª, 3ª… query. */
export function esperaSqlSemDadoClinico(chamadas: unknown[][]): void {
  if (chamadas.length === 0) {
    throw new Error('nenhuma query foi executada — a asserção passaria no vácuo');
  }
  chamadas.forEach((c, i) => {
    const sql = String(c[0] ?? '');
    if (/diagnosis|diagnostico|patholog|patolog/i.test(sql)) {
      throw new Error(`query #${i} pede dado clínico:\n${sql}`);
    }
    if (/join\s+patients/i.test(sql)) {
      throw new Error(`query #${i} faz JOIN em patients:\n${sql}`);
    }
  });
}
