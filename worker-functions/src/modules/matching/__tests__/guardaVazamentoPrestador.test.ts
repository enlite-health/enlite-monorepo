/**
 * Autoteste da guarda — controle POSITIVO em cada função.
 *
 * Uma guarda cujo caminho de DETECÇÃO nunca rodou aprova por omissão: ela some
 * do vermelho não porque nada vazou, mas porque ela não sabe mais acusar. É o
 * mesmo motivo pelo qual o `emiteContatoSemProjecao` planta alvo sintético.
 */

import {
  PRESTADOR_CANARIO,
  esperaSemContatoDePrestador,
  esperaSemDossieDePrestador,
  esperaSemVazamentoDePrestador,
  esperaKmsNaoRodou,
} from './guardaVazamentoPrestador';

describe('guardaVazamentoPrestador — ela ACUSA, e não só deixa passar', () => {
  it('contato: acusa nome, telefone, whatsapp, e-mail e o nome legado', () => {
    for (const vazado of [
      PRESTADOR_CANARIO.primeiroNome,
      PRESTADOR_CANARIO.sobrenome,
      PRESTADOR_CANARIO.nomeLegado,
      PRESTADOR_CANARIO.telefone,
      PRESTADOR_CANARIO.whatsapp,
      PRESTADOR_CANARIO.email,
    ]) {
      expect(() => esperaSemContatoDePrestador({ campo: vazado }))
        .toThrow(/VAZAMENTO DE PRESTADOR \(contato\)/);
    }
  });

  it('dossiê: acusa DNI, nascimento, endereço, foto, raça, religião e orientação', () => {
    for (const vazado of [
      PRESTADOR_CANARIO.documento,
      PRESTADOR_CANARIO.nascimento,
      PRESTADOR_CANARIO.endereco,
      PRESTADOR_CANARIO.fotoUrl,
      PRESTADOR_CANARIO.raca,
      PRESTADOR_CANARIO.religiao,
      PRESTADOR_CANARIO.orientacaoSexual,
    ]) {
      expect(() => esperaSemDossieDePrestador({ campo: vazado }))
        .toThrow(/VAZAMENTO DE PRESTADOR \(dossiê\)/);
    }
  });

  it('os dois níveis são SEPARADOS — contato não acusa dossiê, e vice-versa', () => {
    // É a D168 em teste: telefone e raça não compartilham chave. Uma guarda só
    // para os dois esconderia que são células diferentes.
    expect(() => esperaSemContatoDePrestador({ x: PRESTADOR_CANARIO.raca })).not.toThrow();
    expect(() => esperaSemDossieDePrestador({ x: PRESTADOR_CANARIO.telefone })).not.toThrow();
    expect(() => esperaSemVazamentoDePrestador({ x: PRESTADOR_CANARIO.raca })).toThrow();
    expect(() => esperaSemVazamentoDePrestador({ x: PRESTADOR_CANARIO.telefone })).toThrow();
  });

  it('acha o canário em string crua, em objeto e em argumento de mock', () => {
    expect(() => esperaSemContatoDePrestador(`log: ${PRESTADOR_CANARIO.telefone}`)).toThrow();
    expect(() => esperaSemContatoDePrestador([{ a: { b: PRESTADOR_CANARIO.email } }])).toThrow();
    expect(() => esperaSemContatoDePrestador(['POST', { body: PRESTADOR_CANARIO.nomeLegado }])).toThrow();
  });

  it('objeto circular não derruba a guarda — ela não pode falhar por não saber ler', () => {
    const circular: Record<string, unknown> = { nome: PRESTADOR_CANARIO.primeiroNome };
    circular.eu = circular;
    // `JSON.stringify` lança em ciclo; o `catch` cai para `String(c)`, que não
    // carrega o canário. O que NÃO pode acontecer é a guarda explodir e o teste
    // que a usa virar erro de infraestrutura em vez de veredito.
    expect(() => esperaSemContatoDePrestador(circular)).not.toThrow(/circular/i);
  });

  it('resposta limpa passa — a guarda não é ruído', () => {
    expect(() => esperaSemVazamentoDePrestador({
      success: true,
      data: { id: 'w-1', status: 'ACTIVE', workerName: 'Contato restrito', workerPhone: null },
    })).not.toThrow();
  });

  it('esperaKmsNaoRodou: RECUSA fixture sem campo cifrado — 0 chamadas não prova nada', () => {
    const espiao = { mock: { calls: [] as unknown[][] } };
    expect(() => esperaKmsNaoRodou(espiao, 0)).toThrow(/ERRO DE USO/);
    expect(() => esperaKmsNaoRodou(espiao, -1)).toThrow(/ERRO DE USO/);
  });

  it('esperaKmsNaoRodou: acusa o KMS que rodou, e aprova o que não rodou', () => {
    expect(() => esperaKmsNaoRodou({ mock: { calls: [['enc:x']] } }, 1))
      .toThrow(/o KMS rodou 1x/);
    expect(() => esperaKmsNaoRodou({ mock: { calls: [] } }, 3)).not.toThrow();
  });
});
