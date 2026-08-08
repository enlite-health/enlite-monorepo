import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Search } from 'lucide-react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type {
  PatientDetail,
  PatientChatCandidate,
} from '@domain/entities/PatientDetail';
import { Button } from '@presentation/components/atoms/Button';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { FormField } from '@presentation/components/molecules/FormField';
import { SelectField, type SelectOption } from '@presentation/components/molecules/SelectField';

interface Props {
  patient: PatientDetail;
  onClose: () => void;
  onSaved: () => void;
}

const CLOSE_MS = 300;

/**
 * PatientChatIdsEditDrawer — vinculação SEMIAUTOMÁTICA dos dois chat IDs.
 *
 * Automático na BUSCA, humano na ESCOLHA (desenho aceito pelo Marcel na call de
 * 05/08): o sistema consulta o Periskope e ranqueia por semelhança com o nome do
 * paciente, mas quem diz qual grupo é da família e qual é dos prestadores é a
 * pessoa. Errar isso é auditoria errada na Candela, e nome de grupo não carrega
 * essa informação de forma confiável.
 */
export function PatientChatIdsEditDrawer({ patient, onClose, onSaved }: Props): JSX.Element {
  const { t } = useTranslation();
  const tc = (k: string) => t(`admin.patients.detail.chatIdsCard.${k}`);

  const [show, setShow] = useState(false);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [searched, setSearched] = useState(false);
  const [candidates, setCandidates] = useState<PatientChatCandidate[]>([]);
  const [totalGroups, setTotalGroups] = useState(0);
  const [listTruncated, setListTruncated] = useState(false);
  const [family, setFamily] = useState<string>(patient.familyChatId ?? '');
  const [providers, setProviders] = useState<string>(patient.providersChatId ?? '');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const id = requestAnimationFrame(() => setShow(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const handleClose = (): void => {
    setShow(false);
    setTimeout(onClose, CLOSE_MS);
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSearch = async (): Promise<void> => {
    setError(null);
    setSearching(true);
    try {
      const res = await AdminApiService.getPatientChatCandidates(patient.id);
      setCandidates(res.candidates);
      setTotalGroups(res.totalGroups);
      setListTruncated(res.groupListTruncated === true);
      setSearched(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : tc('searchError'));
    } finally {
      setSearching(false);
    }
  };

  const handleSave = async (): Promise<void> => {
    setError(null);
    setSaving(true);
    try {
      await AdminApiService.updatePatientChatIds(patient.id, {
        familyChatId: family || null,
        providersChatId: providers || null,
      });
      onSaved();
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : tc('saveError'));
    } finally {
      setSaving(false);
    }
  };

  /**
   * Opções dos dois seletores.
   *
   * Inclui o que JÁ está gravado no paciente mesmo antes de qualquer busca —
   * sem isso o `<select>` abre em branco para quem já tem vínculo (o valor não
   * existe entre as options), e a tela mente dizendo "nada escolhido". O grupo
   * já escolhido no outro papel some daqui: o mesmo grupo não pode ser família
   * E prestadores (400 no backend, CHECK no banco).
   */
  const optionsFor = (exclude: string, current: string): SelectOption[] => {
    const fromCandidates: SelectOption[] = candidates.map(c => ({
      value: c.chatId,
      label: `${c.chatName ?? c.chatId}${c.linkedToOtherPatient ? ` — ${tc('alreadyLinked')}` : ''}`,
    }));
    const seen = new Set(fromCandidates.map(o => o.value));
    const linked: SelectOption[] = [];
    for (const v of [current, patient.familyChatId, patient.providersChatId]) {
      // `seen` cresce no laço: os três valores podem coincidir entre si, e uma
      // option repetida quebra a key do React (chave duplicada no <select>).
      if (v && !seen.has(v)) {
        seen.add(v);
        linked.push({ value: v, label: v });
      }
    }

    return [...fromCandidates, ...linked].filter(o => o.value !== exclude);
  };

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-300 ${show ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={handleClose}
        data-testid="chat-ids-backdrop"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={tc('drawerTitle')}
        className={`fixed top-0 right-0 h-screen z-50 w-full max-w-xl bg-white shadow-2xl rounded-tl-[32px] rounded-bl-[32px] flex flex-col transition-transform duration-300 ease-in-out ${show ? 'translate-x-0' : 'translate-x-full'}`}
        data-testid="chat-ids-drawer"
      >
        <div className="flex items-center justify-between px-8 py-5 border-b border-slate-100 shrink-0">
          <Heading level={3} weight="semibold" color="primary">{tc('drawerTitle')}</Heading>
          <div className="flex items-center gap-4">
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={handleSave}
              isLoading={saving}
              className="w-32"
              data-testid="chat-ids-save"
            >
              {tc('save')}
            </Button>
            <button
              type="button"
              onClick={handleClose}
              aria-label={tc('close')}
              className="text-slate-400 hover:text-slate-700 transition-colors p-1 rounded"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-8 py-6 flex flex-col gap-5">
          <Text size="sm" color="muted">{tc('drawerHelp')}</Text>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleSearch}
            isLoading={searching}
            className="self-start"
            data-testid="chat-ids-search-btn"
          >
            <span className="inline-flex items-center gap-2">
              <Search className="w-4 h-4" />
              {tc('searchChats')}
            </span>
          </Button>

          {searched && (
            <div className="flex flex-col gap-2" data-testid="chat-ids-candidates">
              <Text size="sm" weight="medium" color="primary">
                {tc('candidatesTitle')} ({candidates.length}/{totalGroups})
              </Text>
              {listTruncated && (
                <div
                  className="border border-amber-400 bg-amber-50 rounded-lg px-4 py-2"
                  data-testid="chat-ids-truncated-warning"
                  role="alert"
                >
                  <Text size="sm" className="text-amber-800">{tc('listTruncated')}</Text>
                </div>
              )}
              {candidates.length === 0 && (
                <div data-testid="chat-ids-empty">
                  <Text size="sm" color="muted">{tc('noCandidates')}</Text>
                </div>
              )}
              {candidates.map(c => (
                <div
                  key={c.chatId}
                  className="border border-gray-300 rounded-lg px-4 py-2 flex flex-col"
                  data-testid={`chat-candidate-${c.chatId}`}
                >
                  <Text size="sm" weight="medium" color="primary">{c.chatName ?? c.chatId}</Text>
                  <Text size="xs" color="muted" className="font-mono break-all">{c.chatId}</Text>
                  <Text size="xs" color="muted">
                    {tc('score')}: {Math.round(c.score * 100)}%
                    {c.memberCount !== null ? ` · ${c.memberCount} ${tc('members')}` : ''}
                    {c.linkedToOtherPatient ? ` · ${tc('alreadyLinked')}` : ''}
                  </Text>
                </div>
              ))}
            </div>
          )}

          <FormField label={tc('family')} htmlFor="chat-ids-family" optional>
            <SelectField
              inputSize="compact"
              options={optionsFor(providers, family)}
              placeholder={tc('choose')}
              value={family}
              onChange={setFamily}
              data-testid="chat-ids-family-select"
            />
          </FormField>

          <FormField label={tc('providers')} htmlFor="chat-ids-providers" optional>
            <SelectField
              inputSize="compact"
              options={optionsFor(family, providers)}
              placeholder={tc('choose')}
              value={providers}
              onChange={setProviders}
              data-testid="chat-ids-providers-select"
            />
          </FormField>

          {error && (
            <div data-testid="chat-ids-error">
              <Text size="sm" className="text-red-600">{error}</Text>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
