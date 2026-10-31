/**
 * useAssistentes — estado do widget de chat com os asistentes (spec 080, fase A).
 * `listar()` já filtra por célula ABAC no backend: lista vazia (ou falha) = o widget não existe.
 * A aba (agente ativo) é lembrada em `localStorage` (`assistentes.aba`), sempre com try/catch.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AdminAssistentesApiService } from "@infrastructure/http/AdminAssistentesApiService";
import {
  AssistenteErro,
  type Assistente,
  type AssistenteMensagem,
} from "@domain/entities/Assistente";

export const ABA_STORAGE_KEY = "assistentes.aba";

/** Chave i18n (sob `admin.assistentes.`) do aviso de cada erro. */
export type AssistenteAviso =
  "teto" | "sinAcceso" | "erroModelo" | "erroIndisponivel" | "erroGenerico";

export function avisoDoErro(e: unknown): AssistenteAviso {
  if (!(e instanceof AssistenteErro)) return "erroGenerico";
  switch (e.code) {
    case "TETO_PESSOA_DIA":
    case "TETO_AGENTE_MES":
      return "teto";
    case "SEM_CELULA":
      return "sinAcceso";
    case "ERRO_MODELO":
      return "erroModelo";
    case "AGENTE_INDISPONIVEL":
      return "erroIndisponivel";
    default:
      return "erroGenerico";
  }
}

function lerAba(): string | null {
  try {
    return window.localStorage.getItem(ABA_STORAGE_KEY);
  } catch {
    return null;
  }
}

function gravarAba(slug: string): void {
  try {
    window.localStorage.setItem(ABA_STORAGE_KEY, slug);
  } catch {
    /* sem storage (janela privada): a aba só não é lembrada */
  }
}

export interface UseAssistentes {
  agentes: Assistente[];
  ativo: Assistente | null;
  setAba: (slug: string) => void;
  mensagens: AssistenteMensagem[];
  aguardando: boolean;
  aviso: AssistenteAviso | null;
  naoLidas: number;
  enviar: (texto: string) => Promise<void>;
  /** Carrega o histórico do agente ativo (chamado quando o painel abre ou a aba troca). */
  carregarConversa: () => void;
}

export function useAssistentes(): UseAssistentes {
  const [agentes, setAgentes] = useState<Assistente[]>([]);
  const [abaSlug, setAbaSlug] = useState<string | null>(() => lerAba());
  const [porAgente, setPorAgente] = useState<
    Record<string, AssistenteMensagem[]>
  >({});
  const [aguardando, setAguardando] = useState(false);
  const [aviso, setAviso] = useState<AssistenteAviso | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    let vivo = true;
    AdminAssistentesApiService.listar()
      .then((l) => vivo && setAgentes(l))
      .catch(() => vivo && setAgentes([]));
    return () => {
      vivo = false;
    };
  }, []);

  const ativo = agentes.find((a) => a.slug === abaSlug) ?? agentes[0] ?? null;

  const setAba = useCallback((slug: string) => {
    gravarAba(slug);
    setAbaSlug(slug);
    setAviso(null);
  }, []);

  const carregarConversa = useCallback(() => {
    if (!ativo || !ativo.disponivel) return;
    const slug = ativo.slug;
    AdminAssistentesApiService.mensagens(slug)
      // Não atropela o que a pessoa já enviou enquanto o histórico chegava (corrida envio × carga).
      .then((p) =>
        setPorAgente((m) =>
          m[slug]?.length ? m : { ...m, [slug]: p.mensagens },
        ),
      )
      .catch(() => undefined);
  }, [ativo]);

  const enviar = useCallback(
    async (texto: string) => {
      if (!ativo || !ativo.disponivel || !texto.trim()) return;
      const slug = ativo.slug;
      const local: AssistenteMensagem = {
        id: `local-${++seq.current}`,
        autor: "pessoa",
        texto,
        ferramentas: [],
        validador: null,
        criado_em: new Date().toISOString(),
      };
      setPorAgente((m) => ({ ...m, [slug]: [...(m[slug] ?? []), local] }));
      setAviso(null);
      setAguardando(true);
      try {
        const r = await AdminAssistentesApiService.enviar(slug, texto);
        setPorAgente((m) => ({
          ...m,
          [slug]: [...(m[slug] ?? []), r.mensagem],
        }));
      } catch (e) {
        setAviso(avisoDoErro(e));
      } finally {
        setAguardando(false);
      }
    },
    [ativo],
  );

  return {
    agentes,
    ativo,
    setAba,
    mensagens: ativo ? (porAgente[ativo.slug] ?? []) : [],
    aguardando,
    aviso,
    naoLidas: agentes.reduce((s, a) => s + a.nao_lidas, 0),
    enviar,
    carregarConversa,
  };
}
