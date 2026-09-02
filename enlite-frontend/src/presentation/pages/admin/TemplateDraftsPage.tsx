/**
 * /admin/plantillas/registrar — o COMPOSITOR (spec 010, Tela 2 do desenho).
 *
 * Uma coluna para escrever, outra para ver. A da direita tem duas coisas: o
 * balão do WhatsApp com valores de exemplo, e a lista de tudo que precisa estar
 * certo antes de a Meta olhar.
 *
 * 🔒 O QUE MUDOU EM 01/09 E POR QUÊ. Esta tela era um formulário de CRUD —
 * `name`, `slug`, `<select>` de idioma, `<select>` com `UTILITY`/`MARKETING`
 * crus, um textarea e uma caixa cinza de pré-visualização. Ela cumpria os
 * requisitos e não era a tela desenhada, e a diferença não é estética:
 *   · pedia a categoria da Meta a quem não trabalha na Meta;
 *   · deixava digitar `{{...}}` livremente — um jeito de escrever mensagem que
 *     a Meta aprova e que nunca consegue sair;
 *   · tratava cada idioma como um cadastro separado, quando o par é a unidade;
 *   · mostrava o texto, não como ele CHEGA.
 *
 * 🔒 A LISTA DE VERIFICAÇÃO NÃO TEM RÉGUA PRÓPRIA. Ela chama
 * `POST /template-drafts/validar`, que roda `validarRascunho` — a mesma função
 * que decide na gravação. Reimplementar as regras aqui criaria duas verdades, e
 * a que a pessoa vê não seria a que decide.
 *
 * 🔒 ENVIAR continua sendo irreversível e continua atrás da modal que enumera o
 * que se torna irreversível, com o checkbox travando o botão.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  AdminTemplateDraftsApiService,
  DraftApiError,
  type ProblemaDeRegra,
  type TemplateDraft,
} from '@infrastructure/http/AdminTemplateDraftsApiService';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import { Button } from '@presentation/components/atoms/Button';
import { TemplateDraftAvisos } from './TemplateDraftAvisos';
import { TemplateDraftConfirmDialog } from './TemplateDraftConfirmDialog';
import { TemplateComposerForm } from './TemplateComposerForm';
import { TemplateComposerPreview } from './TemplateComposerPreview';
import { TemplateComposerChecklist } from './TemplateComposerChecklist';
import { inicialDaURL } from './templateDraftsView';
import {
  ES, PT, categoriaDoTipo, listaDeVerificacao, tipoDaCategoria,
  type Idioma, type TipoDeMensagem,
} from './templateComposerView';

/** Quanto esperar depois da última tecla antes de perguntar ao servidor. */
const ESPERA_VALIDACAO_MS = 400;

const VAZIO = {
  tipo: 'aviso' as TipoDeMensagem,
  base: '',
  idiomas: [ES, PT] as Idioma[],
  abaAtiva: ES as Idioma,
  textos: { [ES]: '', [PT]: '' } as Record<Idioma, string>,
};

export function TemplateDraftsPage(): JSX.Element {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const [drafts, setDrafts] = useState<TemplateDraft[] | null>(null);

  /**
   * O estado inicial vem da URL quando se chega pelo "＋ Crear versión" ou pelo
   * "Duplicar y corregir". `useState` com inicializador roda UMA vez: a pessoa
   * pode apagar o que veio da URL sem o valor voltar a cada render.
   */
  const [form, setForm] = useState(() => {
    const daURL = inicialDaURL(searchParams, { slug: '', language: ES as string, body: '' });
    const idioma = (daURL.language === PT ? PT : ES) as Idioma;
    return {
      ...VAZIO,
      base: daURL.slug,
      // Chegando por um link de idioma específico, a aba abre NAQUELE idioma —
      // senão a pessoa clicou em "criar a versão em português" e caiu no
      // espanhol, tendo de descobrir sozinha que precisa trocar de aba.
      abaAtiva: idioma,
      textos: { ...VAZIO.textos, [idioma]: daURL.body },
    };
  });

  /** O rascunho em edição, por idioma. Vazio = tudo novo. */
  const [editando, setEditando] = useState<Partial<Record<Idioma, TemplateDraft>>>({});
  const [bloqueios, setBloqueios] = useState<ProblemaDeRegra[]>([]);
  const [avisosDaValidacao, setAvisosDaValidacao] = useState<ProblemaDeRegra[]>([]);
  const [erroKey, setErroKey] = useState<string | null>(null);
  const [erroBruto, setErroBruto] = useState<string | null>(null);
  const [salvoKey, setSalvoKey] = useState<string | null>(null);
  const [avisosSalvos, setAvisosSalvos] = useState<ProblemaDeRegra[]>([]);
  const [salvando, setSalvando] = useState(false);
  const [confirmando, setConfirmando] = useState<TemplateDraft | null>(null);
  const [enviando, setEnviando] = useState(false);

  const categoria = categoriaDoTipo(form.tipo);
  const corpoAtivo = form.textos[form.abaAtiva] ?? '';
  /** O outro idioma selecionado ainda sem texto — vira item de aviso na lista. */
  const faltaOutro = form.idiomas.some((i) => i !== form.abaAtiva && (form.textos[i] ?? '').trim().length === 0);

  const carregar = useCallback(async () => {
    try {
      const r = await AdminTemplateDraftsApiService.listDrafts();
      setDrafts(r.drafts);
    } catch {
      setDrafts([]);
      setErroKey('admin.templateDrafts.erroCarregar');
    }
  }, []);

  useEffect(() => { void carregar(); }, [carregar]);

  /**
   * Chegando por `?draft=<id>`, abre AQUELE rascunho para edição.
   *
   * 🔒 É o que substitui o bloco "Borradores guardados" que ficava no pé desta
   * página. As quatro ações mudaram para o detalhe da mensagem (Tela 4), que é
   * onde o desenho as põe; o que sobrou aqui foi a porta de entrada — e ela
   * precisa ser explícita. Por `?base=` não daria: esse parâmetro também chega
   * pelo "duplicar y corregir", que quer um rascunho NOVO com o texto de um
   * Content já submetido. Adivinhar pela base faria a correção sobrescrever o
   * original em vez de criar o substituto.
   *
   * `jaAbriu` porque `editar` reescreve o formulário inteiro: sem a trava, todo
   * recarregamento da lista (depois de gravar, por exemplo) jogaria fora o que
   * a pessoa acabou de digitar.
   */
  const jaAbriu = useRef(false);
  useEffect(() => {
    const id = searchParams.get('draft');
    if (id === null || jaAbriu.current || drafts === null) return;
    const d = drafts.find((x) => x.id === id);
    if (!d) return;
    jaAbriu.current = true;
    editar(d);
    // `editar` é recriado a cada render e não entra nas dependências de
    // propósito: quem manda aqui é a chegada dos rascunhos, uma vez só.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts, searchParams]);

  /**
   * A validação ao vivo, com espera.
   *
   * ⚠️ `AbortController` + a espera existem pelo mesmo motivo: sem eles, cada
   * tecla vira uma requisição, e as respostas podem chegar FORA DE ORDEM — a
   * resposta de um texto antigo sobrescreveria a de um texto novo, e a lista
   * mostraria problemas de algo que já não está escrito. O último pedido é o
   * único que pode escrever no estado.
   */
  const ultimoPedido = useRef(0);
  useEffect(() => {
    if (form.base.trim().length === 0 || corpoAtivo.trim().length === 0) {
      setBloqueios([]); setAvisosDaValidacao([]);
      return;
    }
    const meu = ++ultimoPedido.current;
    const id = setTimeout(() => {
      void AdminTemplateDraftsApiService.validarRascunho({
        slug: form.base, name: form.base, body: corpoAtivo,
        category: categoria, language: form.abaAtiva,
      }).then((r) => {
        if (meu !== ultimoPedido.current) return;
        setBloqueios(r.bloqueios); setAvisosDaValidacao(r.avisos);
      }).catch(() => {
        /*
         * 🔒 Falha de validação NÃO vira erro na tela, e não é descuido. A
         * pessoa está no meio de uma frase; um vermelho aqui seria sobre a
         * rede, não sobre o texto dela. Quem decide de verdade é a gravação, e
         * essa sim reporta. A lista simplesmente para de atualizar.
         */
        if (meu === ultimoPedido.current) { setBloqueios([]); setAvisosDaValidacao([]); }
      });
    }, ESPERA_VALIDACAO_MS);
    return () => clearTimeout(id);
  }, [form.base, corpoAtivo, categoria, form.abaAtiva]);

  const itensDaLista = useMemo(
    () => listaDeVerificacao([...bloqueios, ...avisosDaValidacao], corpoAtivo, faltaOutro),
    [bloqueios, avisosDaValidacao, corpoAtivo, faltaOutro],
  );

  const limpar = (): void => {
    setForm({ ...VAZIO, textos: { [ES]: '', [PT]: '' } });
    setEditando({});
    setBloqueios([]); setAvisosDaValidacao([]); setAvisosSalvos([]);
    setErroKey(null); setErroBruto(null);
  };

  /** Reabre um rascunho salvo — e o par dele, quando existe. */
  const editar = (d: TemplateDraft): void => {
    const irmaos = (drafts ?? []).filter((x) => x.baseName === d.baseName && x.status === 'draft');
    const textos = { [ES]: '', [PT]: '' } as Record<Idioma, string>;
    const emEdicao: Partial<Record<Idioma, TemplateDraft>> = {};
    for (const x of irmaos) {
      const i = (x.language === PT ? PT : ES) as Idioma;
      textos[i] = x.body; emEdicao[i] = x;
    }
    setForm({
      tipo: tipoDaCategoria(d.category),
      base: d.baseName,
      idiomas: irmaos.map((x) => (x.language === PT ? PT : ES)) as Idioma[],
      abaAtiva: (d.language === PT ? PT : ES) as Idioma,
      textos,
    });
    setEditando(emEdicao);
    setBloqueios([]); setAvisosDaValidacao([]); setAvisosSalvos([]);
    setErroKey(null); setSalvoKey(null);
  };

  /**
   * Grava uma linha por idioma COM TEXTO.
   *
   * 🔒 Idioma marcado e ainda em branco é PULADO, não gravado vazio. O desenho
   * é explícito — "podés enviar solo el español ahora y el otro después" — e um
   * rascunho de corpo vazio seria recusado pelo backend (`body.obrigatorio`),
   * transformando "ainda não traduzi" num erro.
   */
  const salvar = async (): Promise<void> => {
    setSalvando(true);
    setBloqueios([]); setErroKey(null); setErroBruto(null); setSalvoKey(null);
    const avisosDeTodos: ProblemaDeRegra[] = [];
    try {
      for (const idioma of form.idiomas) {
        const body = form.textos[idioma] ?? '';
        if (body.trim().length === 0) continue;
        const entrada = { slug: form.base, name: form.base, body, category: categoria, language: idioma };
        const existente = editando[idioma];
        const r = existente
          ? await AdminTemplateDraftsApiService.updateDraft(existente.id, { ...entrada, version: existente.version })
          : await AdminTemplateDraftsApiService.createDraft(entrada);
        avisosDeTodos.push(...(r.avisos ?? []));
      }
      setSalvoKey('admin.templateDrafts.salvoNaoEnviado');
      limpar();
      // DEPOIS do `limpar`, que zera os avisos: eles são sobre o que acabou de
      // ser gravado, e zerar em seguida apagaria a única vez que a pessoa vê
      // que a mensagem saiu sem caminho de saída.
      setAvisosSalvos(avisosDeTodos);
      await carregar();
    } catch (e: unknown) {
      if (e instanceof DraftApiError) {
        if (e.problemas.length > 0) setBloqueios(e.problemas);
        else if (e.status === 409) setErroKey(`admin.templateDrafts.conflito.${e.codigo}`);
        else setErroBruto(e.message);
      } else {
        setErroKey('admin.templateDrafts.erroSalvar');
      }
    } finally {
      setSalvando(false);
    }
  };

  const enviar = async (d: TemplateDraft): Promise<void> => {
    setEnviando(true);
    setErroKey(null); setErroBruto(null); setSalvoKey(null);
    try {
      await AdminTemplateDraftsApiService.submitDraft(d.id);
      setSalvoKey('admin.templateDrafts.enviado');
      setConfirmando(null);
      await carregar();
    } catch (e: unknown) {
      if (e instanceof DraftApiError) {
        if (e.status === 503) setErroKey(`admin.templateDrafts.indisponivel.${e.motivo}`);
        else if (e.problemas.length > 0) { setBloqueios(e.problemas); setConfirmando(null); }
        else if (e.codigo) setErroKey(`admin.templateDrafts.envioErro.${e.codigo}`);
        else setErroBruto(e.message);
      } else {
        setErroKey('admin.templateDrafts.erroEnviar');
      }
    } finally {
      setEnviando(false);
    }
  };

  /*
   * ⚠️ `duplicar` e `arquivar` SAÍRAM daqui, não sumiram. Eles pertenciam ao
   * bloco "Borradores guardados", que mudou para o detalhe da mensagem — junto
   * com `editar` e `enviar`. Esta tela voltou a fazer uma coisa só: compor.
   */

  /** O rascunho que o "Revisar y enviar" leva à modal: o do idioma da aba. */
  const paraEnviar = editando[form.abaAtiva] ?? null;

  return (
    <PageContainer>
      {/*
        * 🔒 O AVISO ÂMBAR SAIU DAQUI, e não se perdeu informação.
        * Ele dizia "guardar não envia nada; o envio é um passo aparte" — que é
        * exatamente o que o SUBTÍTULO já diz ("Guardá el borrador cuantas veces
        * quieras. Recién cuando la envíes a Meta el texto queda fijo") e o que a
        * modal enumera em cinco pontos antes do clique. Eram três lugares
        * repetindo a mesma coisa, e a maquete usa um. Aviso repetido não avisa
        * mais: ensina a ignorar a cor.
        */}
      <div className="mb-5">
        <Link to="/admin/plantillas" data-testid="td-voltar-catalogo">
          <Text size="xs" color="secondary">{t('admin.templateDrafts.voltarCatalogo')}</Text>
        </Link>
        <Heading level={1} size="compact">{t('admin.templateDrafts.title')}</Heading>
        {/* A maquete usa 12,5px; `xs` é 12 — meio pixel, e meio pixel de fonte
            não vira token. Ver o cabeçalho de `Text`. */}
        <Text size="xs" color="secondary">{t('admin.templateDrafts.subtitle')}</Text>
      </div>

      <TemplateDraftAvisos avisos={avisosSalvos} />
      {salvoKey && (
        <div className="mb-4 rounded border border-green-300 bg-green-50 p-3" data-testid="td-salvo">
          <Text size="sm" color="inherit" className="text-green-800">{t(salvoKey)}</Text>
        </div>
      )}
      {(erroKey || erroBruto) && (
        <div className="mb-4 rounded border border-red-300 bg-red-50 p-3" data-testid="td-erro">
          <Text size="sm" color="inherit" className="text-red-700">
            {erroKey ? t(erroKey, t('admin.templateDrafts.conflito.generico')) : erroBruto}
          </Text>
        </div>
      )}

      <div className="grid gap-0 lg:grid-cols-[1.05fr_0.95fr]" data-testid="td-form">
        <TemplateComposerForm
          tipo={form.tipo} base={form.base} idiomas={form.idiomas}
          abaAtiva={form.abaAtiva} textos={form.textos}
          travadoNoIdioma={Object.keys(editando).length === 1 ? (Object.keys(editando)[0] as Idioma) : null}
          onTipo={(tipo) => setForm((f) => ({ ...f, tipo }))}
          onBase={(base) => setForm((f) => ({ ...f, base }))}
          onIdiomas={(idiomas) => setForm((f) => ({ ...f, idiomas }))}
          onAba={(abaAtiva) => setForm((f) => ({ ...f, abaAtiva }))}
          onTexto={(i, texto) => setForm((f) => ({ ...f, textos: { ...f.textos, [i]: texto } }))}
        />

        <div className="flex flex-col gap-4 lg:border-l lg:border-gray-300 lg:pl-7">
          <TemplateComposerPreview corpo={corpoAtivo} />
          <TemplateComposerChecklist itens={itensDaLista} categoria={categoria} />

          {/*
            * 🔒 OS BLOQUEIOS APARECEM INTEIROS, e não só através da lista de
            * verificação. A lista mapeia as regras que ela sabe desenhar; uma
            * regra fora desse mapa (categoria inválida, idioma inválido, ou
            * qualquer uma acrescentada depois) cairia no vazio — o estado
            * mudaria, a gravação teria falhado, e a tela não diria nada. Foi
            * exatamente o buraco que a primeira versão desta página tinha.
            */}
          {bloqueios.length > 0 && (
            <div className="rounded border border-red-300 bg-red-50 p-3" data-testid="td-bloqueios">
              {/* Agrupado POR CAMPO: um `<ul>` por campo, um `<li>` por regra.
                  Vários problemas no mesmo campo aparecem TODOS — mostrar só o
                  primeiro faz a pessoa corrigir, salvar, e descobrir o segundo. */}
              {[...new Set(bloqueios.map((p) => p.campo))].map((campo) => (
                <ul key={campo} className="m-0 list-disc pl-5" data-testid={`td-problemas-${campo}`}>
                  {bloqueios.filter((p) => p.campo === campo).map((p) => (
                    <li key={p.regra}>
                      <Text size="xs" color="inherit" className="text-red-700">
                        {t(`admin.templateDrafts.regra.${p.campo}.${p.regra}`, t('admin.templateDrafts.regra.generica'))}
                      </Text>
                    </li>
                  ))}
                </ul>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2.5">
            {/* 🔒 `bg-white` AQUI, não no atom. A maquete pinta o outline de branco;
                trocar a variante mudaria todo botão outline do app (medido: um
                teste de outra tela pegou). Sondado: `bg-transparent bg-white`
                resolve para branco em qualquer ordem, então a sobrescrita por
                `className` é determinística neste caso — não é loteria de
                cascata como acontece com `font-size`. */}
            <Button size="compact" variant="outline" className="bg-white" data-testid="td-salvar" onClick={() => void salvar()} isLoading={salvando} disabled={salvando}>
              {t('admin.templateDrafts.salvar')}
            </Button>
            {/* Só existe durante a edição: sem ele, quem abriu um rascunho por
                engano não tem como voltar a compor um novo — o formulário fica
                preso no que foi carregado, e a única saída seria recarregar. */}
            {Object.keys(editando).length > 0 && (
              <Button size="compact" variant="outline" data-testid="td-cancelar" onClick={limpar}>
                {t('admin.templateDrafts.cancelar')}
              </Button>
            )}
            {/* 🔒 "Revisar y enviar" só existe para um rascunho JÁ GRAVADO: o
                envio precisa de um `id`, e submeter algo que ainda não está no
                banco criaria um Content na Twilio sem linha nossa apontando
                para ele — órfão que nenhuma tela mostraria. */}
            <Button
              size="compact"
              data-testid="td-revisar-enviar"
              disabled={paraEnviar === null}
              onClick={() => paraEnviar && setConfirmando(paraEnviar)}
            >
              {t('admin.templateDrafts.revisarEnviar')}
            </Button>
            {paraEnviar === null && (
              <Text size="xs" color="secondary" className="basis-full">
                {t('admin.templateDrafts.salveAntesDeEnviar')}
              </Text>
            )}
          </div>
        </div>
      </div>

      {confirmando && (
        <TemplateDraftConfirmDialog
          draft={confirmando}
          enviando={enviando}
          onConfirmar={() => void enviar(confirmando)}
          onCancelar={() => setConfirmando(null)}
        />
      )}
    </PageContainer>
  );
}
