/**
 * ChatGroupPicker — escolhe um grupo buscando na lista INTEIRA da org.
 *
 * POR QUE EXISTE, e por que não é o `<select>` de candidatos.
 *
 * O seletor de candidatos ranqueia por semelhança com o NOME DO PACIENTE e
 * descarta quem pontua zero. Isso acerta 94% para os grupos nomeados pelo
 * paciente ("Flia. Pérez") e é ESTRUTURALMENTE INÚTIL para os que não são: o
 * grupo da obra social chama-se `Gestión: EnLite <> DAS` e não se parece com
 * paciente nenhum — ele NUNCA aparecia na lista de candidatos, por mais que
 * existisse. Sem esta busca, o papel compartilhado é invinculável na prática.
 *
 * Ranquear por paciente responde "qual destes é o grupo DELE?".
 * Esta busca responde "qual é o grupo da OBRA SOCIAL dele?".
 *
 * ⚠️ A contagem de pacientes ao lado de cada grupo NÃO é aviso aqui: num papel
 * compartilhado, "40 pacientes" é exatamente o esperado. Marcar isso como
 * problema — que é o que a tela fazia — treinaria quem opera a ignorar o aviso
 * justamente onde ele importa (no papel exclusivo).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, X, Check } from 'lucide-react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { ChatGroupListItem } from '@domain/entities/PatientDetail';
import { Text } from '@presentation/components/atoms/Text';

interface Props {
  /** chat_id escolhido, ou '' quando não há. */
  value: string;
  onChange: (chatId: string) => void;
  /** Grupos já usados em OUTRO papel deste paciente — o banco recusa repetir. */
  excludeChatIds: readonly string[];
  testIdPrefix: string;
}

/** Quantos resultados por busca. Mais que isso vira rolagem sem ajudar a decidir. */
const SEARCH_LIMIT = 20;

/** Espera antes de consultar. Cada tecla é uma leitura no Periskope. */
const DEBOUNCE_MS = 350;

export function ChatGroupPicker({ value, onChange, excludeChatIds, testIdPrefix }: Props): JSX.Element {
  const { t } = useTranslation();
  const tc = (k: string, o?: Record<string, unknown>) =>
    t(`admin.patients.detail.chatIdsCard.${k}`, o ?? {});

  const [search, setSearch] = useState('');
  const [groups, setGroups] = useState<ChatGroupListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  /** Nome do grupo escolhido, quando a busca já o trouxe. */
  const chosen = groups.find(g => g.chatId === value);

  // `latest` protege contra resposta fora de ordem: quem digita rápido dispara
  // duas buscas, e a mais LENTA pode chegar depois — sem isto a lista mostraria
  // o resultado de um termo que a pessoa já apagou.
  const latest = useRef(0);

  const run = useCallback(async (term: string) => {
    const seq = ++latest.current;
    setLoading(true);
    setError(null);
    try {
      const res = await AdminApiService.listChatGroups({ search: term || undefined, limit: SEARCH_LIMIT });
      if (seq !== latest.current) return;
      setGroups(res.groups);
      setTotal(res.total);
      setTruncated(res.listTruncated);
      setSearched(true);
    } catch (err) {
      if (seq !== latest.current) return;
      setError(err instanceof Error ? err.message : tc('searchError'));
    } finally {
      if (seq === latest.current) setLoading(false);
    }
    // `tc` recria a cada render; a dependência real é só o termo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const id = setTimeout(() => { run(search); }, DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [search, run]);

  const visible = groups.filter(g => !excludeChatIds.includes(g.chatId));

  return (
    <div className="flex flex-col gap-2" data-testid={`${testIdPrefix}-picker`}>
      {value && (
        <div
          className="flex items-center justify-between gap-2 border border-primary/40 bg-primary/5 rounded-lg px-3 py-2"
          data-testid={`${testIdPrefix}-chosen`}
        >
          <div className="flex flex-col min-w-0">
            <Text size="sm" weight="medium" color="primary">{chosen?.chatName ?? value}</Text>
            <Text size="xs" color="muted" className="font-mono break-all">{value}</Text>
          </div>
          <button
            type="button"
            onClick={() => onChange('')}
            className="shrink-0 text-slate-400 hover:text-red-600 transition-colors p-1 rounded cursor-pointer"
            aria-label={tc('clear')}
            data-testid={`${testIdPrefix}-clear`}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={tc('searchGroupPlaceholder')}
          className="w-full border border-gray-300 rounded-lg pl-9 pr-3 py-2 text-sm focus:ring-2 focus:ring-primary focus:border-primary outline-none"
          data-testid={`${testIdPrefix}-search`}
        />
      </div>

      {error && (
        <div className="border border-red-300 bg-red-50 rounded-lg px-3 py-2" role="alert" data-testid={`${testIdPrefix}-error`}>
          <Text size="xs" className="text-red-700">{error}</Text>
        </div>
      )}

      {truncated && (
        <div className="border border-amber-400 bg-amber-50 rounded-lg px-3 py-2" role="alert" data-testid={`${testIdPrefix}-truncated`}>
          <Text size="xs" className="text-amber-800">{tc('listTruncated')}</Text>
        </div>
      )}

      {loading && (
        <Text size="xs" color="muted" data-testid={`${testIdPrefix}-loading`}>{tc('searching')}</Text>
      )}

      {!loading && searched && visible.length === 0 && (
        // ⚠️ Vazio aqui quase nunca é "esse grupo não existe": é "nenhum número
        // nosso está dentro dele". Dizer isso poupa a pessoa de procurar um
        // grupo que nunca esteve ao nosso alcance — é membresia de WhatsApp,
        // não falha de software.
        <div className="border border-gray-300 rounded-lg px-3 py-2" data-testid={`${testIdPrefix}-empty`}>
          <Text size="xs" color="muted">{tc('noGroupsFound')}</Text>
        </div>
      )}

      {!loading && visible.length > 0 && (
        <div className="flex flex-col gap-1 max-h-64 overflow-y-auto" data-testid={`${testIdPrefix}-results`}>
          <Text size="xs" color="muted">{tc('groupsFound', { shown: visible.length, total })}</Text>
          {visible.map(g => {
            const isChosen = g.chatId === value;
            return (
              <button
                key={g.chatId}
                type="button"
                onClick={() => onChange(g.chatId)}
                className={`text-left border rounded-lg px-3 py-2 transition-colors cursor-pointer ${
                  isChosen ? 'border-primary bg-primary/5' : 'border-gray-200 hover:border-primary'
                }`}
                data-testid={`${testIdPrefix}-option-${g.chatId}`}
              >
                <div className="flex items-center gap-2">
                  {isChosen && <Check className="w-3 h-3 text-primary shrink-0" />}
                  <Text as="span" size="sm" weight="medium" color="primary">{g.chatName ?? g.chatId}</Text>
                </div>
                <Text size="xs" color="muted">
                  {g.memberCount !== null ? `${g.memberCount} ${tc('members')} · ` : ''}
                  {/* informação, não alerta — ver o cabeçalho do arquivo */}
                  {tc('usedByPatients', { count: g.linkedPatientCount })}
                </Text>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
