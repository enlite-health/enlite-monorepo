/**
 * As regras determinísticas do rascunho (spec 010, F2 passo 2.2).
 *
 * O que estes testes protegem, em ordem de importância:
 *
 * 1. **Posicional é REPROVADO.** `{{1}}` passaria na Meta e ficaria inelegível
 *    para mensagem por etapa — template aprovado e inutilizável. É o defeito
 *    mais caro que esta validação existe para impedir.
 * 2. **A lista de variáveis é a MESMA do envio.** Vem importada de
 *    `StageTemplateEligibility`; se divergisse, a tela aceitaria variável que o
 *    envio não preenche e o erro só apareceria com a mensagem no ar.
 * 3. `validarRascunho` devolve TODOS os problemas, não o primeiro.
 * 4. `paraTwilio` numera VALORES, não ocorrências.
 */
import { SUPPORTED_PLACEHOLDERS } from '../../application/StageTemplateEligibility';
import {
  CATEGORIAS,
  avisos,
  bloqueios,
  clausulaDeBaja,
  LIMITE_VARIAVEIS,
  idiomaTwilio,
  IDIOMAS,
  LIMITE_CORPO,
  PREFIXO_POR_IDIOMA,
  VARIAVEIS_SUPORTADAS,
  paraTwilio,
  slugComPrefixo,
  tokensDe,
  validarRascunho,
  variaveisDe,
} from '../templateDraftRules';

const ok = {
  slug: 'ar_bienvenida',
  name: 'Bienvenida',
  body: 'Hola {{worker_name}}, te esperamos en la entrevista del caso {{case_number}}.',
  category: 'UTILITY',
  language: 'es-AR',
};

const regras = (e: Partial<typeof ok>) => validarRascunho({ ...ok, ...e }).map((p) => p.regra);
/**
 * O que IMPEDE gravar. Desde 01/09 o retorno de `validarRascunho` mistura
 * bloqueio e aviso: um `toEqual([])` cru passaria a reprovar todo caminho limpo
 * em es-AR só por causa do aviso de AR-01, que é exatamente o que a regra quer
 * que aconteça. "Limpo" passou a significar "nada trava", e o teste diz isso.
 */
const trava = (e: Partial<typeof ok>) => bloqueios(validarRascunho({ ...ok, ...e })).map((p) => p.regra);
const alerta = (e: Partial<typeof ok>) => avisos(validarRascunho({ ...ok, ...e })).map((p) => p.regra);
const campos = (e: Partial<typeof ok>) => validarRascunho({ ...ok, ...e }).map((p) => p.campo);

describe('constantes', () => {
  it('categorias, idiomas e limite são os que a Meta aceita', () => {
    expect(CATEGORIAS).toEqual(['MARKETING', 'UTILITY', 'AUTHENTICATION']);
    expect(IDIOMAS).toEqual(['es-AR', 'pt-BR']);
    expect(LIMITE_CORPO).toBe(1024);
    expect(PREFIXO_POR_IDIOMA).toEqual({ 'es-AR': 'ar_', 'pt-BR': 'br_' });
  });

  it('🔒 as variáveis são AS MESMAS do envio — mesma referência, não uma cópia', () => {
    expect(VARIAVEIS_SUPORTADAS).toBe(SUPPORTED_PLACEHOLDERS);
    expect([...VARIAVEIS_SUPORTADAS].sort()).toEqual(['case_number', 'name', 'worker_name']);
  });
});

describe('idiomaTwilio — o defeito que só a API real pegou', () => {
  it('troca hífen por underscore: es-AR → es_AR, pt-BR → pt_BR', () => {
    expect(idiomaTwilio('es-AR')).toBe('es_AR');
    expect(idiomaTwilio('pt-BR')).toBe('pt_BR');
  });
  it('🔒 o formato NOSSO nunca sai daqui — a Twilio recusa o hífen com 92004', () => {
    for (const nosso of IDIOMAS) {
      expect(idiomaTwilio(nosso)).not.toContain('-');
    }
  });
  it('idioma já no formato da Twilio passa intacto — idempotente', () => {
    expect(idiomaTwilio('es_AR')).toBe('es_AR');
  });
  it('código sem região passa intacto', () => {
    expect(idiomaTwilio('es')).toBe('es');
  });
});

describe('tokensDe / variaveisDe', () => {
  it('tokensDe devolve tudo que está entre chaves, inclusive o inválido', () => {
    expect(tokensDe('a {{worker_name}} b {{1}} c {{nao_existe}}'))
      .toEqual(['worker_name', '1', 'nao_existe']);
  });
  it('tolera espaço dentro das chaves', () => {
    expect(tokensDe('a {{ worker_name }} b')).toEqual(['worker_name']);
  });
  it('variaveisDe filtra só as suportadas, sem repetir, na ordem de aparição', () => {
    expect(variaveisDe('{{case_number}} x {{worker_name}} y {{case_number}} z {{1}}'))
      .toEqual(['case_number', 'worker_name']);
  });
  it('texto sem variável devolve lista vazia', () => {
    expect(tokensDe('sem nenhuma')).toEqual([]);
    expect(variaveisDe('sem nenhuma')).toEqual([]);
  });
});

describe('paraTwilio — a conversão que só acontece na submissão', () => {
  it('nomeado vira posicional na ordem de aparição', () => {
    expect(paraTwilio('Hola {{worker_name}}, caso {{case_number}}')).toEqual({
      body: 'Hola {{1}}, caso {{2}}',
      variaveis: ['worker_name', 'case_number'],
    });
  });
  it('🔒 a MESMA variável repetida reusa o MESMO número — numera valor, não ocorrência', () => {
    expect(paraTwilio('{{worker_name}} y otra vez {{worker_name}}')).toEqual({
      body: '{{1}} y otra vez {{1}}',
      variaveis: ['worker_name'],
    });
  });
  it('token não suportado fica INTACTO — a conversão não inventa número para o que não sabe', () => {
    expect(paraTwilio('a {{nao_existe}} b {{worker_name}}')).toEqual({
      body: 'a {{nao_existe}} b {{1}}',
      variaveis: ['worker_name'],
    });
  });
  it('texto sem variável passa inalterado', () => {
    expect(paraTwilio('Hola a todos')).toEqual({ body: 'Hola a todos', variaveis: [] });
  });
  it('tolera espaço dentro das chaves na conversão', () => {
    expect(paraTwilio('Hola {{ worker_name }}').body).toBe('Hola {{1}}');
  });
});

describe('slugComPrefixo', () => {
  it('acrescenta o prefixo do idioma', () => {
    expect(slugComPrefixo('bienvenida', 'es-AR')).toBe('ar_bienvenida');
    expect(slugComPrefixo('boas_vindas', 'pt-BR')).toBe('br_boas_vindas');
  });
  it('é IDEMPOTENTE — salvar duas vezes não vira ar_ar_x', () => {
    expect(slugComPrefixo('ar_bienvenida', 'es-AR')).toBe('ar_bienvenida');
    expect(slugComPrefixo(slugComPrefixo('x', 'pt-BR'), 'pt-BR')).toBe('br_x');
  });
  it('normaliza caixa, espaço e pontuação', () => {
    expect(slugComPrefixo('  Bienvenida  Nueva! ', 'es-AR')).toBe('ar_bienvenida_nueva');
  });
  it('colapsa underscore repetido e apara as bordas', () => {
    expect(slugComPrefixo('__a---b__', 'es-AR')).toBe('ar_a_b');
  });
});

describe('validarRascunho — o caminho limpo', () => {
  it('rascunho válido não trava nada', () => {
    expect(trava({})).toEqual([]);
  });
  it('texto sem variável é válido — nem toda mensagem tem uma', () => {
    expect(trava({ body: 'Hola, te esperamos.' })).toEqual([]);
  });
  it('exatamente no limite passa; o limite é teto, não parede um antes', () => {
    expect(trava({ body: 'a'.repeat(LIMITE_CORPO) })).toEqual([]);
  });
  it('as três variáveis suportadas passam', () => {
    expect(trava({ body: 'Hola {{worker_name}}, alias {{name}}, del caso {{case_number}}, gracias.' })).toEqual([]);
  });
  it('🔒 todo problema declara a gravidade — sem ela o controller não sabe o que travar', () => {
    const todos = validarRascunho({ ...ok, body: '{{1}} texto', category: 'NADA' });
    expect(todos.length).toBeGreaterThan(0);
    expect(todos.every((p) => p.gravidade === 'bloqueia' || p.gravidade === 'aviso')).toBe(true);
  });
});

describe('validarRascunho — identidade', () => {
  it('nome vazio reprova', () => {
    expect(regras({ name: '   ' })).toContain('obrigatorio');
    expect(campos({ name: '   ' })).toContain('name');
  });
  it('slug vazio reprova', () => {
    expect(campos({ slug: '' })).toContain('slug');
  });
  it('slug com maiúscula ou hífen reprova — a Meta só aceita [a-z0-9_]', () => {
    expect(regras({ slug: 'ar_Bienvenida' })).toContain('formato');
    expect(regras({ slug: 'ar-bienvenida' })).toContain('formato');
  });
  it('categoria fora das três reprova', () => {
    expect(regras({ category: 'PROMO' })).toContain('invalida');
  });
  it('idioma fora dos dois reprova', () => {
    expect(regras({ language: 'en-US' })).toContain('invalido');
  });
});

describe('validarRascunho — corpo', () => {
  it('corpo vazio reprova e ENCERRA — sem texto não há o que dizer das demais', () => {
    expect(validarRascunho({ ...ok, body: '   ' })).toEqual([{ campo: 'body', regra: 'obrigatorio', gravidade: 'bloqueia' }]);
  });
  it('passar do limite reprova', () => {
    expect(regras({ body: 'a'.repeat(LIMITE_CORPO + 1) })).toContain('muito_longo');
  });

  it('🔒 POSICIONAL reprova — aprovaria na Meta e seria inelegível aqui', () => {
    const p = validarRascunho({ ...ok, body: 'Hola {{1}}, todo bien' });
    expect(p.map((x) => x.regra)).toContain('placeholder_posicional');
    expect(p.find((x) => x.regra === 'placeholder_posicional')?.token).toBe('1');
  });
  it('variável desconhecida reprova E NOMEIA qual — a pessoa precisa saber o que trocar', () => {
    const p = validarRascunho({ ...ok, body: 'Hola {{nombre_del_paciente}}, todo bien' });
    expect(p.map((x) => x.regra)).toContain('variavel_desconhecida');
    expect(p.find((x) => x.regra === 'variavel_desconhecida')?.token).toBe('nombre_del_paciente');
  });
  it('a mesma variável inválida repetida reprova UMA vez, não uma por ocorrência', () => {
    const p = validarRascunho({ ...ok, body: 'a {{xx}} b {{xx}} c' });
    expect(p.filter((x) => x.regra === 'variavel_desconhecida')).toHaveLength(1);
  });

  it('começar com variável reprova — a Meta não avalia sem texto em volta', () => {
    expect(regras({ body: '{{worker_name}} bienvenida a bordo' })).toContain('placeholder_no_inicio');
  });
  it('terminar com variável reprova', () => {
    expect(regras({ body: 'te esperamos, {{worker_name}}' })).toContain('placeholder_no_fim');
  });
  it('duas variáveis coladas reprovam', () => {
    expect(regras({ body: 'hola {{worker_name}}{{case_number}} vamos' })).toContain('placeholders_adjacentes');
  });
  it('coladas com espaço no meio também reprovam', () => {
    expect(regras({ body: 'hola {{worker_name}} {{case_number}} vamos' })).toContain('placeholders_adjacentes');
  });

  it('devolve TODOS os problemas de uma vez, não só o primeiro', () => {
    const p = validarRascunho({ slug: 'X!', name: '', body: '{{1}}', category: 'NOPE', language: 'de' });
    expect(new Set(p.map((x) => x.campo))).toEqual(new Set(['slug', 'name', 'body', 'category', 'language']));
    expect(p.length).toBeGreaterThanOrEqual(5);
  });
});

describe('META-02 — no máximo 10 variáveis', () => {
  // O conjunto suportado tem 3 nomes; para passar de 10 DISTINTOS é preciso
  // inventar nomes, que já reprovam por `variavel_desconhecida`. O que este
  // teste protege é a contagem em si: ela é sobre DISTINTOS.
  const onzeDistintos = 'Hola ' + Array.from({ length: 11 }, (_, i) => `{{v${i}}}`).join(' y ') + ' fin.';
  const dezDistintos = 'Hola ' + Array.from({ length: 10 }, (_, i) => `{{v${i}}}`).join(' y ') + ' fin.';

  it('onze distintas reprovam', () => {
    expect(trava({ body: onzeDistintos })).toContain('variaveis_demais');
  });
  it('dez passam — o limite é teto', () => {
    expect(trava({ body: dezDistintos })).not.toContain('variaveis_demais');
    expect(LIMITE_VARIAVEIS).toBe(10);
  });
  it('🔒 conta DISTINTAS, não ocorrências — `paraTwilio` reusa o número na repetição', () => {
    const repetida = 'Hola {{worker_name}}, ' + '{{worker_name}} '.repeat(20) + 'fin.';
    expect(trava({ body: repetida })).not.toContain('variaveis_demais');
  });
});

describe('META-05 — símbolo proibido dentro da variável', () => {
  it.each(['#', '$', '%'])('`%s` na variável reprova', (simbolo) => {
    expect(trava({ body: `Hola {{worker${simbolo}name}}, gracias.` })).toContain('variavel_com_simbolo');
  });
  it('🔒 e NÃO se disfarça de `variavel_desconhecida` — a pessoa trocaria o nome e erraria de novo', () => {
    const rs = trava({ body: 'Hola {{worker#name}}, gracias.' });
    expect(rs).toContain('variavel_com_simbolo');
    expect(rs).not.toContain('variavel_desconhecida');
  });
  it('variável desconhecida SEM símbolo continua sendo desconhecida', () => {
    expect(trava({ body: 'Hola {{apellido}}, gracias.' })).toContain('variavel_desconhecida');
  });
});

describe('clausulaDeBaja — o detector', () => {
  it('convite + termo que o inbound honra é cláusula de verdade', () => {
    const c = clausulaDeBaja('Hola. Respondé BAJA para no recibir más mensajes.');
    expect(c.tipo).toBe('reconhecida');
  });
  it('frase inequívoca também conta', () => {
    expect(clausulaDeBaja('Escribí "darme de baja" cuando quieras.').tipo).toBe('reconhecida');
  });
  it('🔒 termo EXACT casa por PALAVRA — e é um caminho diferente do das frases', () => {
    // «Respondé BAJA para no recibir más» casaria antes em OPT_OUT_CONTAINS
    // ('no recibir mas') e nunca chegaria ao laço de EXACT. Sem uma frase curta
    // como esta, a busca com fronteira de palavra fica sem teste — e foi o que
    // a cobertura acusou: o `return termo` do laço EXACT, nunca alcançado.
    expect(clausulaDeBaja('Hola. Respondé BAJA cuando quieras.')).toEqual({ tipo: 'reconhecida', termo: 'baja' });
  });
  it('sem convite nenhum é ausente', () => {
    expect(clausulaDeBaja('Hola María, tu entrevista quedó confirmada.').tipo).toBe('ausente');
  });
  it('🔒 o termo sozinho NÃO é cláusula — "podés cancelar tu entrevista" não dá saída de nada', () => {
    expect(clausulaDeBaja('Si no podés venir, podés cancelar tu entrevista.').tipo).toBe('ausente');
  });
  it('🔒 fronteira de palavra: "sacarte la duda" não vira `sacar`', () => {
    expect(clausulaDeBaja('Respondé este mensaje para sacarte la duda.').tipo).toBe('nao_reconhecida');
  });
  it('🔒 O CASO QUE JUSTIFICA A FUNÇÃO: promete saída com palavra que o inbound NÃO honra', () => {
    // Quem responder «NO MÁS» não é dado de baixa: o termo não está em
    // OPT_OUT_EXACT nem em OPT_OUT_CONTAINS. A promessa falha em silêncio.
    expect(clausulaDeBaja('Respondé NO MÁS para dejar de recibir esto.').tipo).toBe('nao_reconhecida');
  });
});

describe('AR-01 e MKT-02 — avisam, nunca bloqueiam', () => {
  const semSaida = 'Hola, te esperamos en la entrevista.';
  const comSaida = 'Hola, te esperamos. Respondé BAJA para no recibir más mensajes.';

  it('es-AR sem cláusula avisa AR-01', () => {
    expect(alerta({ language: 'es-AR', category: 'UTILITY', body: semSaida })).toEqual(['sem_clausula_de_baja']);
  });
  it('🔒 e NÃO trava — a decisão é de quem escreve (emenda do Gabriel, 01/09)', () => {
    expect(trava({ language: 'es-AR', category: 'UTILITY', body: semSaida })).toEqual([]);
  });
  it('pt-BR MARKETING sem cláusula avisa MKT-02', () => {
    expect(alerta({ language: 'pt-BR', slug: 'br_x', category: 'MARKETING', body: semSaida })).toEqual(['sem_caminho_de_saida']);
  });
  it('pt-BR UTILITY não avisa nada — nem AR-01 nem MKT-02 se aplicam', () => {
    expect(alerta({ language: 'pt-BR', slug: 'br_x', category: 'UTILITY', body: semSaida })).toEqual([]);
  });
  it('🔒 es-AR MARKETING dá UM aviso só — duas linhas sobre o mesmo texto faltando é ruído', () => {
    expect(alerta({ language: 'es-AR', category: 'MARKETING', body: semSaida })).toEqual(['sem_clausula_de_baja']);
  });
  it('com cláusula reconhecida não avisa nada', () => {
    expect(alerta({ language: 'es-AR', category: 'MARKETING', body: comSaida })).toEqual([]);
  });
  it('🔒 cláusula que promete saída inexistente tem chave PRÓPRIA — é pior que ausente', () => {
    const body = 'Hola. Respondé NO MÁS para dejar de recibir esto.';
    expect(alerta({ language: 'es-AR', body })).toEqual(['clausula_de_baja_nao_reconhecida']);
  });
});
