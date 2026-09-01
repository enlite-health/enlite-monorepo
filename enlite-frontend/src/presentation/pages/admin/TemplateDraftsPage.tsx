/**
 * A tela de REGISTRAR mensagem (spec 010, F2 passos 2.1 e 2.2).
 *
 * A pessoa escreve, vê como a cuidadora vai receber, e salva. Ponto.
 *
 * 🔒 REGISTRO: o botão "enviar para autorização" escreve para FORA do perímetro
 * e o parecer do `lex` NÃO foi emitido — o Gabriel determinou construir assim em
 * 31/08/2026. A submissão sobe DESLIGADA por flag no servidor; sem ela a tela
 * recebe 503 e diz o motivo, em vez de fingir que enviou.
 *
 * ⚠️ Enviar é IRREVERSÍVEL: o nome do template fica queimado na WABA mesmo se a
 * Meta recusar. Por isso o botão abre uma confirmação que ENUMERA o que se torna
 * irreversível, e só o "sim" dela dispara — critério da própria spec.
 *
 * Depois de enviado, editar deixa de existir: a tela oferece "duplicar e
 * corrigir", porque o texto que foi para a Meta não pode ser reescrito por baixo.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AdminTemplateDraftsApiService,
  DraftApiError,
  type ProblemaDeRegra,
  type TemplateDraft,
} from '@infrastructure/http/AdminTemplateDraftsApiService';
import { VARIAVEIS_AJUDA } from './templateDraftsView';
import { TemplateDraftConfirmDialog } from './TemplateDraftConfirmDialog';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import { Button } from '@presentation/components/atoms/Button';
import { Input } from '@presentation/components/atoms/Input';
import { Textarea } from '@presentation/components/atoms/Textarea';
import { Select } from '@presentation/components/atoms/Select';
import { Label } from '@presentation/components/atoms/Label';
import {
  CATEGORIAS,
  IDIOMAS,
  chaveDeProblema,
  previewDe,
  problemasPorCampo,
  restante,
  slugPrevisto,
} from './templateDraftsView';

const VAZIO = { slug: '', name: '', body: '', category: 'UTILITY', language: 'es-AR' };

export function TemplateDraftsPage(): JSX.Element {
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState<TemplateDraft[] | null>(null);
  const [form, setForm] = useState({ ...VAZIO });
  const [editando, setEditando] = useState<TemplateDraft | null>(null);
  const [problemas, setProblemas] = useState<ProblemaDeRegra[]>([]);
  // 🔒 Estes dois guardam CHAVE, não texto traduzido. Guardar o texto obrigaria
  // `carregar` a depender de `t`, e `t` muda de identidade a cada render — o
  // efeito re-dispararia para sempre. State guarda código; quem traduz é o JSX.
  const [erroKey, setErroKey] = useState<string | null>(null);
  /** Mensagem literal vinda do servidor (500). Não é chave — não passa por `t`. */
  const [erroBruto, setErroBruto] = useState<string | null>(null);
  const [salvoKey, setSalvoKey] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  /** O rascunho aguardando confirmação de envio. `null` = nenhum diálogo aberto. */
  const [confirmando, setConfirmando] = useState<TemplateDraft | null>(null);
  const [enviando, setEnviando] = useState(false);

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

  const porCampo = useMemo(() => problemasPorCampo(problemas), [problemas]);
  const slugFinal = useMemo(() => slugPrevisto(form.slug, form.language), [form.slug, form.language]);
  const preview = useMemo(() => previewDe(form.body), [form.body]);
  const sobra = restante(form.body);

  const primeiro = (campo: string): string | undefined => {
    const p = porCampo[campo]?.[0];
    return p ? t(chaveDeProblema(p), t('admin.templateDrafts.regra.generica')) : undefined;
  };

  /**
   * Renderiza os motivos abaixo do campo.
   *
   * ⚠️ Não é enfeite: os atoms `Input`/`Textarea` usam a prop `error` apenas
   * para a borda vermelha e o `aria-invalid` — eles NÃO mostram o texto. Sem
   * isto a pessoa via o campo vermelho e nunca lia o porquê, que é justamente
   * o que esta tela existe para evitar.
   */
  const motivos = (campo: string): JSX.Element | null => {
    const ps = porCampo[campo];
    if (!ps || ps.length === 0) return null;
    return (
      <ul className="mt-1 list-disc pl-5" data-testid={`td-problemas-${campo}`}>
        {ps.map((p) => (
          <li key={p.regra}>
            <Text size="xs" color="inherit" className="text-red-700">
              {t(chaveDeProblema(p), t('admin.templateDrafts.regra.generica'))}
            </Text>
          </li>
        ))}
      </ul>
    );
  };

  const limpar = (): void => {
    setForm({ ...VAZIO });
    setEditando(null);
    setProblemas([]);
    setErroKey(null);
  };

  const editar = (d: TemplateDraft): void => {
    setForm({ slug: d.slug, name: d.name, body: d.body, category: d.category, language: d.language });
    setEditando(d);
    setProblemas([]);
    setErroKey(null);
    setSalvoKey(null);
  };

  const salvar = async (): Promise<void> => {
    setSalvando(true);
    setProblemas([]);
    setErroKey(null);
    setErroBruto(null);
    setSalvoKey(null);
    try {
      if (editando) {
        await AdminTemplateDraftsApiService.updateDraft(editando.id, { ...form, version: editando.version });
      } else {
        await AdminTemplateDraftsApiService.createDraft(form);
      }
      setSalvoKey('admin.templateDrafts.salvoNaoEnviado');
      limpar();
      await carregar();
    } catch (e: unknown) {
      if (e instanceof DraftApiError) {
        if (e.problemas.length > 0) {
          setProblemas(e.problemas);
        } else if (e.status === 409) {
          // Conflito não é "erro de sistema": é outra pessoa tendo gravado, ou
          // um nome já em uso. A tela nomeia qual dos dois, porque a ação da
          // pessoa é diferente em cada caso.
          setErroKey(`admin.templateDrafts.conflito.${e.codigo}`);
        } else {
          setErroBruto(e.message);
        }
      } else {
        setErroKey('admin.templateDrafts.erroSalvar');
      }
    } finally {
      setSalvando(false);
    }
  };

  const enviar = async (d: TemplateDraft): Promise<void> => {
    setEnviando(true);
    setErroKey(null);
    setErroBruto(null);
    setSalvoKey(null);
    try {
      await AdminTemplateDraftsApiService.submitDraft(d.id);
      setSalvoKey('admin.templateDrafts.enviado');
      setConfirmando(null);
      await carregar();
    } catch (e: unknown) {
      if (e instanceof DraftApiError) {
        if (e.status === 503) {
          // 503 não é "deu erro": é "está desligado", e a pessoa precisa saber
          // qual dos dois motivos para saber a quem pedir.
          setErroKey(`admin.templateDrafts.indisponivel.${e.motivo}`);
        } else if (e.problemas.length > 0) {
          setProblemas(e.problemas);
          setConfirmando(null);
        } else if (e.codigo) {
          setErroKey(`admin.templateDrafts.envioErro.${e.codigo}`);
        } else {
          setErroBruto(e.message);
        }
      } else {
        setErroKey('admin.templateDrafts.erroEnviar');
      }
    } finally {
      setEnviando(false);
    }
  };

  const duplicar = async (d: TemplateDraft): Promise<void> => {
    try {
      const r = await AdminTemplateDraftsApiService.duplicateDraft(d.id);
      await carregar();
      editar(r.draft);
    } catch {
      setErroKey('admin.templateDrafts.erroDuplicar');
    }
  };

  const arquivar = async (d: TemplateDraft): Promise<void> => {
    try {
      await AdminTemplateDraftsApiService.archiveDraft(d.id);
      if (editando?.id === d.id) limpar();
      await carregar();
    } catch {
      setErroKey('admin.templateDrafts.erroArquivar');
    }
  };

  return (
    <PageContainer>
      <div className="mb-6">
        <Heading level={1}>{t('admin.templateDrafts.title')}</Heading>
        <Text size="sm" color="secondary">{t('admin.templateDrafts.subtitle')}</Text>
      </div>

      {/* O aviso mais importante da tela: salvo ≠ submetido. */}
      <div className="mb-6 rounded border border-amber-300 bg-amber-50 p-3" data-testid="td-aviso-perimetro">
        <Text size="sm" color="inherit" className="text-amber-800">
          {t('admin.templateDrafts.avisoNaoEnvia')}
        </Text>
      </div>

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

      <div className="mb-8 grid gap-4 md:grid-cols-2" data-testid="td-form">
        <div>
          <Label htmlFor="td-name" required>{t('admin.templateDrafts.campo.name')}</Label>
          <Input
            id="td-name" data-testid="td-input-name" value={form.name}
            error={primeiro('name')}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          {motivos('name')}
        </div>

        <div>
          <Label htmlFor="td-slug" required>{t('admin.templateDrafts.campo.slug')}</Label>
          <Input
            id="td-slug" data-testid="td-input-slug" value={form.slug}
            error={primeiro('slug')}
            onChange={(e) => setForm({ ...form, slug: e.target.value })}
          />
          {motivos('slug')}
          {slugFinal && (
            <Text size="xs" color="secondary">
              <span data-testid="td-slug-previsto">
                {t('admin.templateDrafts.slugFicaraComo', { slug: slugFinal })}
              </span>
            </Text>
          )}
        </div>

        <div>
          <Label htmlFor="td-language" required>{t('admin.templateDrafts.campo.language')}</Label>
          <Select
            id="td-language" data-testid="td-select-language" value={form.language}
            error={primeiro('language')}
            options={IDIOMAS.map((v) => ({ value: v, label: t(`admin.templateDrafts.idioma.${v}`, v) }))}
            onValueChange={(v) => setForm({ ...form, language: v })}
          />
          {motivos('language')}
        </div>

        <div>
          <Label htmlFor="td-category" required>{t('admin.templateDrafts.campo.category')}</Label>
          <Select
            id="td-category" data-testid="td-select-category" value={form.category}
            error={primeiro('category')}
            options={CATEGORIAS.map((v) => ({ value: v, label: t(`admin.templateDrafts.categoria.${v}`, v) }))}
            onValueChange={(v) => setForm({ ...form, category: v })}
          />
          {motivos('category')}
        </div>

        <div className="md:col-span-2">
          <Label htmlFor="td-body" required>{t('admin.templateDrafts.campo.body')}</Label>
          <Textarea
            id="td-body" data-testid="td-input-body" rows={5} value={form.body}
            error={primeiro('body')}
            onChange={(e) => setForm({ ...form, body: e.target.value })}
          />
          <Text size="xs" color={sobra < 0 ? 'inherit' : 'secondary'} className={sobra < 0 ? 'text-red-700' : ''}>
            <span data-testid="td-restante">{t('admin.templateDrafts.restante', { n: sobra })}</span>
          </Text>
          {motivos('body')}
          <Text size="xs" color="secondary">
            <span data-testid="td-variaveis-ajuda">
              {t('admin.templateDrafts.variaveisDisponiveis', { lista: VARIAVEIS_AJUDA.map((v) => `{{${v}}}`).join(', ') })}
            </span>
          </Text>
        </div>

        <div className="md:col-span-2">
          <Text size="xs" color="secondary">{t('admin.templateDrafts.preview')}</Text>
          <div className="rounded border border-gray-200 bg-gray-50 p-3" data-testid="td-preview">
            <Text size="sm" color="inherit">{preview || t('admin.templateDrafts.previewVazio')}</Text>
          </div>
        </div>

        <div className="flex gap-2 md:col-span-2">
          <Button data-testid="td-salvar" onClick={() => void salvar()} isLoading={salvando} disabled={salvando}>
            {editando ? t('admin.templateDrafts.salvarEdicao') : t('admin.templateDrafts.salvar')}
          </Button>
          {editando && (
            <Button variant="outline" data-testid="td-cancelar" onClick={limpar}>
              {t('admin.templateDrafts.cancelar')}
            </Button>
          )}
        </div>
      </div>

      {confirmando && (
        <TemplateDraftConfirmDialog
          slug={confirmando.slug}
          enviando={enviando}
          onConfirmar={() => void enviar(confirmando)}
          onCancelar={() => setConfirmando(null)}
        />
      )}

      <Heading level={2}>{t('admin.templateDrafts.listaTitulo')}</Heading>
      {drafts === null ? (
        <Text size="sm" color="secondary"><span data-testid="td-carregando">{t('admin.templateDrafts.carregando')}</span></Text>
      ) : drafts.length === 0 ? (
        <Text size="sm" color="secondary"><span data-testid="td-vazio">{t('admin.templateDrafts.vazio')}</span></Text>
      ) : (
        <ul className="divide-y" data-testid="td-lista">
          {drafts.map((d) => (
            <li key={d.id} className="flex items-center justify-between py-3" data-testid={`td-item-${d.slug}`}>
              <div className="min-w-0">
                <Text size="sm" color="inherit">{d.name}</Text>
                <Text size="xs" color="secondary">{d.slug} · {d.language} · {d.category}</Text>
                <Text size="xs" color="secondary">
                  <span data-testid={`td-estado-${d.slug}`}>
                    {d.status === 'submitted'
                      ? t('admin.templateDrafts.estado.submitted')
                      : t('admin.templateDrafts.estado.draft')}
                  </span>
                </Text>
                {d.submissionError && (
                  <Text size="xs" color="inherit" className="text-red-700">
                    <span data-testid={`td-falha-${d.slug}`}>
                      {t('admin.templateDrafts.ultimaFalha', { erro: d.submissionError })}
                    </span>
                  </Text>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                {d.status === 'submitted' ? (
                  // Submetido não se edita: o texto foi para a Meta e reescrevê-lo
                  // por baixo faria o banco discordar do que está lá fora.
                  <Button size="sm" variant="outline" data-testid={`td-duplicar-${d.slug}`} onClick={() => void duplicar(d)}>
                    {t('admin.templateDrafts.duplicar')}
                  </Button>
                ) : (
                  <>
                    <Button size="sm" variant="outline" data-testid={`td-editar-${d.slug}`} onClick={() => editar(d)}>
                      {t('admin.templateDrafts.editar')}
                    </Button>
                    <Button size="sm" data-testid={`td-enviar-${d.slug}`} onClick={() => setConfirmando(d)}>
                      {t('admin.templateDrafts.enviar')}
                    </Button>
                  </>
                )}
                <Button size="sm" variant="outline" data-testid={`td-arquivar-${d.slug}`} onClick={() => void arquivar(d)}>
                  {t('admin.templateDrafts.arquivar')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </PageContainer>
  );
}
