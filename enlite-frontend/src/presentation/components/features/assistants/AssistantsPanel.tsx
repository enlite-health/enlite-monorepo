/**
 * AssistentesPainel — painel 360×480 (celular: tela cheia): cabeçalho com o agente (seletor `Combobox`
 * se > 1), abas, conversa e composer. Cores: texto #262626, secundário/placeholder #404040 (≥ 7:1).
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Combobox } from "@presentation/components/atoms/Combobox/Combobox";
import { Textarea } from "@presentation/components/atoms/Textarea/Textarea";
import type { UseAssistentes } from "@presentation/hooks/useAssistentes";

interface Props {
  assistentes: UseAssistentes;
  onFechar: () => void;
}

export function AssistentesPainel({ assistentes: a, onFechar }: Props) {
  const { t } = useTranslation();
  const [texto, setTexto] = useState("");
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const { ativo, agentes, carregarConversa } = a;
  const slugAtivo = ativo?.slug;

  useEffect(() => {
    composerRef.current?.focus();
  }, [slugAtivo]);

  useEffect(() => {
    carregarConversa();
  }, [carregarConversa]);

  if (!ativo) return null;
  const indisponivel = !ativo.disponivel;
  const opcoes = agentes.map((g) => ({
    value: g.slug,
    label: g.disponivel
      ? g.nome
      : `${g.nome} · ${t("admin.assistentes.enBreve")}`,
  }));

  const enviar = () => {
    if (indisponivel || a.aguardando || !texto.trim()) return;
    const v = texto;
    setTexto("");
    void a.enviar(v);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      enviar();
    }
  };

  return (
    <div
      role="dialog"
      aria-label={t("admin.assistentes.titulo")}
      data-testid="assistentes-painel"
      onKeyDown={(e) => e.key === "Escape" && onFechar()}
      className="fixed z-50 flex flex-col overflow-hidden bg-white font-poppins text-[#262626] shadow-large inset-0 sm:inset-auto sm:bottom-6 sm:right-6 sm:h-[480px] sm:w-[360px] sm:rounded-card"
    >
      <header className="border-b border-gray-600 px-4 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            {agentes.length > 1 ? (
              <Combobox
                data-testid="assistentes-seletor"
                aria-label={t("admin.assistentes.titulo")}
                options={opcoes}
                value={ativo.slug}
                onChange={(v) => v && a.setAba(v)}
                valueClassName="text-[#262626]"
              />
            ) : (
              <p className="text-base font-semibold text-[#262626]">
                {ativo.nome}
              </p>
            )}
            <p className="mt-1 text-xs text-[#404040]">{ativo.area}</p>
            <p className="text-xs text-[#404040]">
              {t("admin.assistentes.tuGrupo", {
                grupo: ativo.area,
                n: agentes.length,
              })}
            </p>
          </div>
          <button
            type="button"
            data-testid="assistentes-cerrar"
            aria-label={t("admin.assistentes.cerrar")}
            onClick={onFechar}
            className="rounded-full p-1 text-[#262626]"
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        {agentes.length > 1 && (
          <div role="tablist" className="mt-2 flex gap-1 overflow-x-auto">
            {agentes.map((g) => (
              <button
                key={g.slug}
                type="button"
                role="tab"
                aria-selected={g.slug === ativo.slug}
                data-testid={`assistentes-aba-${g.slug}`}
                onClick={() => a.setAba(g.slug)}
                className={`whitespace-nowrap rounded-full px-3 py-1 text-xs ${
                  g.slug === ativo.slug
                    ? "bg-primary text-white"
                    : "bg-gray-200 text-[#262626]"
                }`}
              >
                {g.nome}
              </button>
            ))}
          </div>
        )}
      </header>

      <div
        className="flex-1 space-y-2 overflow-y-auto px-4 py-3"
        aria-live="polite"
      >
        {a.mensagens.map((m) => (
          <div
            key={m.id}
            data-testid={`assistentes-msg-${m.id}`}
            className={`max-w-[85%] whitespace-pre-wrap rounded-[14px] px-3 py-2 text-sm ${
              m.autor === "pessoa"
                ? "ml-auto bg-primary text-white"
                : "bg-gray-200 text-[#262626]"
            }`}
          >
            {m.texto}
          </div>
        ))}
        {a.aguardando && (
          <p
            data-testid="assistentes-escribiendo"
            className="text-xs italic text-[#404040]"
          >
            {t("admin.assistentes.escribiendo")}
          </p>
        )}
        {a.aviso && (
          <p
            role="alert"
            data-testid="assistentes-aviso"
            className="text-sm text-[#262626]"
          >
            {t(`admin.assistentes.${a.aviso}`, { agente: ativo.nome })}
          </p>
        )}
        {indisponivel && (
          <p className="text-sm text-[#404040]">
            {t("admin.assistentes.enBreve")}
          </p>
        )}
      </div>

      <div className="flex items-end gap-2 border-t border-gray-600 px-4 py-3">
        <Textarea
          ref={composerRef}
          data-testid="assistentes-composer"
          aria-label={t("admin.assistentes.placeholder")}
          placeholder={t("admin.assistentes.placeholder")}
          rows={2}
          value={texto}
          disabled={indisponivel}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={onKeyDown}
          className="flex-1 !text-[#262626] placeholder:!text-[#404040]"
        />
        <button
          type="button"
          data-testid="assistentes-enviar"
          disabled={indisponivel || a.aguardando || !texto.trim()}
          onClick={enviar}
          className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {t("admin.assistentes.enviar")}
        </button>
      </div>
      <p className="px-4 pb-3 text-[11px] text-[#404040]">
        {t("admin.assistentes.rodape")}
      </p>
    </div>
  );
}
