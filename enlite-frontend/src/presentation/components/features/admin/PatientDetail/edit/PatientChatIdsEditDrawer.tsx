import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Search } from 'lucide-react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type {
  PatientDetail,
  PatientChatCandidate,
} from '@domain/entities/PatientDetail';
import { chatRolesToDisplay, chatRoleLabelKey } from '@domain/value-objects/patientChatRole';
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
 * PatientChatIdsEditDrawer — vinculação SEMIAUTOMÁTICA dos grupos, por papel.
 *
 * Automático na BUSCA, humano na ESCOLHA (desenho aceito pelo Marcel na call de
 * 05/08): o sistema consulta o Periskope e ranqueia por semelhança com o nome do
 * paciente, mas quem diz qual grupo é de qual papel é a pessoa. Errar isso é
 * auditoria errada na Candela, e nome de grupo não carrega essa informação de
 * forma confiável.
 *
 * Um seletor por papel, gerados a partir do catálogo — somar um papel não mexe
 * neste arquivo.
 */
export function PatientChatIdsEditDrawer({ patient, onClose, onSaved }: Props): JSX.Element {
  const { t } = useTranslation();
  const tc = (k: string) => t(`admin.patients.detail.chatIdsCard.${k}`);

  const roles = chatRolesToDisplay(patient.chatIds);

  const [show, setShow] = useState(false);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [searched, setSearched] = useState(false);
  const [candidates, setCandidates] = useState<PatientChatCandidate[]>([]);
  const [totalGroups, setTotalGroups] = useState(0);
  const [listTruncated, setListTruncated] = useState(false);
  const [selection, setSelection] = useState<Record<string, string>>(() =>
    Object.fromEntries(roles.map(role => [role, patient.chatIds?.[role] ?? ''])),
  );
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
      // Manda TODOS os papéis da tela, inclusive os vazios (null = desvincular):
      // o que a pessoa vê é o que fica gravado. Papel que a tela não mostra não
      // entra no payload e por isso não é apagado.
      await AdminApiService.updatePatientChatIds(patient.id, {
        chatIds: Object.fromEntries(roles.map(role => [role, selection[role] || null])),
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
   * Opções do seletor de um papel.
   *
   * Inclui o que JÁ está gravado no paciente mesmo antes de qualquer busca —
   * sem isso o `<select>` abre em branco para quem já tem vínculo (o valor não
   * existe entre as options), e a tela mente dizendo "nada escolhido". Os grupos
   * já escolhidos em OUTRO papel somem daqui: o mesmo grupo não pode ocupar dois
   * papéis do mesmo paciente (400 no backend, UNIQUE no banco).
   */
  const optionsFor = (role: string): SelectOption[] => {
    const takenHere = new Set(
      roles.filter(r => r !== role).map(r => selection[r]).filter(Boolean),
    );

    const fromCandidates: SelectOption[] = candidates.map(c => ({
      value: c.chatId,
      label: `${c.chatName ?? c.chatId}${c.linkedToOtherPatient ? ` — ${tc('alreadyLinked')}` : ''}`,
    }));

    const seen = new Set(fromCandidates.map(o => o.value));
    const linked: SelectOption[] = [];
    // `seen` cresce no laço: os valores podem coincidir entre si, e uma option
    // repetida quebra a key do React (chave duplicada no <select>).
    for (const v of [selection[role], ...roles.map(r => patient.chatIds?.[r])]) {
      if (v && !seen.has(v)) {
        seen.add(v);
        linked.push({ value: v, label: v });
      }
    }

    return [...fromCandidates, ...linked].filter(o => !takenHere.has(o.value));
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

          {roles.map(role => (
            <FormField
              key={role}
              label={t(chatRoleLabelKey(role), { defaultValue: role })}
              htmlFor={`chat-ids-${role}`}
              optional
            >
              <SelectField
                inputSize="compact"
                options={optionsFor(role)}
                placeholder={tc('choose')}
                value={selection[role] ?? ''}
                onChange={value => setSelection(prev => ({ ...prev, [role]: value }))}
                data-testid={`chat-ids-${role}-select`}
              />
            </FormField>
          ))}

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
