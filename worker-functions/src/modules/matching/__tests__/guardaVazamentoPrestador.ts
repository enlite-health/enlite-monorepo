/**
 * Guarda compartilhada contra vazamento de dado de PRESTADOR — irmã da
 * `guardaVazamentoClinico` (D170), pelo mesmo motivo que ela existe.
 *
 * O defeito clínico reincidiu três vezes porque cada guarda procurava a palavra
 * que o autor DELA lembrou. Aqui o risco é idêntico e já está instalado: os
 * quatro testes de rota da F2/C3 nasceram cada um com o seu canário —
 * `'María'`, `'González'`, `'+5491133445566'`, `'Carlos Legado'`. Enquanto o
 * vocabulário for por autor, a 5ª rota vai inventar o 5º nome e vazar em paz.
 *
 * ── Por que este arquivo é SEPARADO do clínico ──────────────────────────────
 * A `esperaSqlSemDadoClinico` reprova `JOIN patients`, o que é certo no caminho
 * do short-link (que não deve tocar paciente nenhum) e errado numa rota de vaga.
 * Regra que vale num contexto e não no outro não sobe para helper comum: ela
 * viraria falso positivo, e gate que reprova o certo se aprende a ignorar
 * (D172). O que generaliza é o CANÁRIO e a asserção de fronteira.
 */

/** Valores que só existem para vazar. Nenhum é nome real de ninguém. */
export const PRESTADOR_CANARIO = {
  primeiroNome: 'CanarioNome',
  sobrenome: 'CanarioSobrenome',
  /** O nome montado, como a projeção o devolve. */
  nomeCompleto: 'CanarioNome CanarioSobrenome',
  /** Texto claro do import legado (`encuadres.worker_raw_name`). */
  nomeLegado: 'CanarioLegado DoImport',
  telefone: '+5490000000001',
  whatsapp: '+5490000000002',
  email: 'canario@nao-pode-sair.test',
  documento: 'CANARIO-DNI-00000001',
  nascimento: '1900-01-01',
  endereco: 'Rua Canario 000',
  fotoUrl: 'https://canario.test/foto.jpg',
  raca: 'CanarioRaca',
  religiao: 'CanarioReligiao',
  orientacaoSexual: 'CanarioOrientacao',
} as const;

/** Nível de contato — o que `worker_contact:read` protege. */
const CONTATO = [
  PRESTADOR_CANARIO.primeiroNome,
  PRESTADOR_CANARIO.sobrenome,
  PRESTADOR_CANARIO.nomeLegado,
  PRESTADOR_CANARIO.telefone,
  PRESTADOR_CANARIO.whatsapp,
  PRESTADOR_CANARIO.email,
];

/** Nível de dossiê — o que `worker_pii:read` protege. */
const DOSSIE = [
  PRESTADOR_CANARIO.documento,
  PRESTADOR_CANARIO.nascimento,
  PRESTADOR_CANARIO.endereco,
  PRESTADOR_CANARIO.fotoUrl,
  PRESTADOR_CANARIO.raca,
  PRESTADOR_CANARIO.religiao,
  PRESTADOR_CANARIO.orientacaoSexual,
];

function texto(coisas: unknown[]): string {
  return coisas
    .map((c) => {
      if (typeof c === 'string') return c;
      try { return JSON.stringify(c); } catch { return String(c); }
    })
    .join('\n');
}

function acusa(nivel: string, coisas: unknown[], proibidos: readonly string[]): void {
  const tudo = texto(coisas);
  for (const p of proibidos) {
    if (tudo.toLowerCase().includes(p.toLowerCase())) {
      throw new Error(
        `VAZAMENTO DE PRESTADOR (${nivel}): "${p}" atravessou a fronteira.\n` +
        `O que saiu:\n${tudo.slice(0, 2000)}`,
      );
    }
  }
}

/** Falha se contato de prestador atravessar — nome, telefone, whatsapp, e-mail. */
export function esperaSemContatoDePrestador(...coisas: unknown[]): void {
  acusa('contato', coisas, CONTATO);
}

/** Falha se dossiê atravessar — DNI, nascimento, endereço, foto, raça, religião, orientação. */
export function esperaSemDossieDePrestador(...coisas: unknown[]): void {
  acusa('dossiê', coisas, DOSSIE);
}

/** Falha se QUALQUER nível atravessar. O default para rota que não devia mostrar nada. */
export function esperaSemVazamentoDePrestador(...coisas: unknown[]): void {
  acusa('contato', coisas, CONTATO);
  acusa('dossiê', coisas, DOSSIE);
}

/**
 * A asserção que a C3 exige e que a de fronteira NÃO substitui: o KMS não rodou.
 *
 * Redigir depois de descriptografar deixa a resposta correta e o texto claro já
 * existiu em memória, num stack trace do KMS e possivelmente num log. Só a
 * contagem de chamadas vê isso.
 *
 * ⚠️ Espião com ZERO chamadas E zero campos cifrados na fixture é sucesso vazio.
 * Por isso esta função exige que a fixture tenha sido cifrada de fato — quem
 * chama passa `cifradosNaFixture`, e 0 aqui é ERRO DE USO, não aprovação.
 */
export function esperaKmsNaoRodou(
  espiao: { mock: { calls: unknown[][] } },
  cifradosNaFixture: number,
): void {
  if (cifradosNaFixture <= 0) {
    throw new Error(
      'ERRO DE USO: a fixture não tinha nenhum campo cifrado — um espião com 0 ' +
      'chamadas não prova nada quando não havia o que descriptografar.',
    );
  }
  const n = espiao.mock.calls.length;
  if (n !== 0) {
    throw new Error(
      `A célula não autorizava, mas o KMS rodou ${n}x. Redigir DEPOIS de ` +
      `descriptografar é esconder da tela, não redigir.`,
    );
  }
}
