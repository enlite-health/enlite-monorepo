---
name: analyze-video
description: Analisa um vídeo (webm/mp4/mov) ou o vídeo anexado a uma task do ClickUp e devolve, SEM poluir o contexto principal, o que foi falado na narração, se houve problemática, e os pontos a corrigir/alterar. Use quando o user mandar um vídeo (caminho/URL) ou pedir pra "ver o vídeo desta task". Extrai frames + transcreve áudio + analisa em lotes via subagentes.
---

# Analyze Video — pipeline de análise de vídeo fora do contexto principal

Eu não "vejo" vídeo nativamente (Read só faz imagem/PDF/notebook). Esta skill orquestra a extração + transcrição + análise por subagentes e devolve um relatório estruturado. **Princípio inegociável: o contexto principal só vê o resumo executivo final** — todo o I/O pesado (frames, transcrição, relatórios por lote) vive em arquivos e em subagentes.

## Input

`$ARGUMENTS` é um destes:
- **Caminho local** de vídeo (ex: `docs/adr/foo.webm`)
- **URL** de vídeo (download direto)
- **Task do ClickUp** (ID `86xxxxxx` ou URL `https://app.clickup.com/t/...`) → o vídeo é um anexo da task

Se vier vazio/ambíguo, peça o caminho/URL/task antes de prosseguir.

---

## Passo 0 — Resolver a fonte do vídeo

- **Caminho local**: usar direto. Confirmar que existe (`ls -la`).
- **URL**: `curl -sL -o "$SP/source_video" "<url>"`.
- **ClickUp**: chamar `mcp__clickup__getTaskById` com o ID. Nos campos de attachments, achar o item com `type`/`extension` de vídeo (`.webm`/`.mp4`/`.mov`) e baixar a `url`/`url_w_query` com `curl -sL`. Se a task tiver mais de um vídeo, listar e perguntar qual. Se não tiver vídeo, devolver "task X não tem vídeo anexado" e parar.

`SP` = diretório scratchpad da sessão. Criar `mkdir -p "$SP/video-analysis/frames"`.

## Passo 1 — Probe

```
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "<video>"
ffprobe -v error -select_streams a -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "<video>"
```

Guardar **duração** (segundos, arredondar pra cima) e se **há faixa de áudio**. Sem áudio → pular a transcrição (Passo 3) e avisar no relatório que não houve narração.

**Exclusão dura**: vídeo > 30 min (1800s) → NÃO rodar inteiro automaticamente. Avisar o tamanho e perguntar se quer mesmo (custo) ou um recorte de tempo.

## Passo 2 — Extrair frames + áudio (1 frame/seg)

```
ffmpeg -v error -i "<video>" -vf "fps=1,scale=1280:-1" -q:v 3 "$SP/video-analysis/frames/f_%03d.jpg"
ffmpeg -v error -i "<video>" -vn -c:a libmp3lame -q:a 4 "$SP/video-analysis/audio.mp3"   # só se houver áudio
```

`frame N = segundo N`. Conferir a contagem (`ls frames | wc -l`).

## Passo 3 — Transcrição da narração (só se houver áudio)

whisper.cpp normalmente já está instalado (`whisper-cli`). Setup idempotente:
- Binário ausente → `brew install whisper-cpp`.
- Modelo ausente em `~/.cache/whisper-cpp/ggml-small.bin` → `mkdir -p ~/.cache/whisper-cpp && curl -sL -o ~/.cache/whisper-cpp/ggml-small.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin` (~466MB, durável — NÃO rebaixar se já existe).

whisper.cpp exige WAV 16kHz mono:
```
ffmpeg -v error -y -i "$SP/video-analysis/audio.mp3" -ar 16000 -ac 1 -c:a pcm_s16le "$SP/video-analysis/audio16k.wav"
whisper-cli -m ~/.cache/whisper-cpp/ggml-small.bin -f "$SP/video-analysis/audio16k.wav" -l es -otxt -of "$SP/video-analysis/transcript"
```

Idioma default `es` (contexto Enlite = espanhol AR). Aceitar override via arg `--lang xx`. **A narração costuma misturar ES/PT → a transcrição vem com ruído; ler pelo sentido, não literal.** Rodar a transcrição em **background** (12 min de áudio leva minutos) e seguir pro Passo 4 em paralelo.

## Passo 4 — Análise dos frames em lotes (PARALELO, escreve em arquivo)

Dividir os frames em **lotes de ~75**. `nLotes = ceil(nFrames/75)`, no máximo 12 agentes (lotes maiores se passar disso). Disparar **todos os subagentes `general-purpose` numa única mensagem** (paralelo).

**Para não poluir o contexto principal, cada agente ESCREVE seu relatório num arquivo e retorna só uma linha.** Prompt-template de cada agente (ajustar o range e o número do lote):

> Você é analista de UX. Frames de gravação de tela (1 frame/seg; frame N = segundo N) de `<contexto: ex. fluxo de cadastro, UI em espanhol>`.
> Leia EM ORDEM, com Read, os arquivos `$SP/video-analysis/frames/f_AAA.jpg` até `f_BBB.jpg`. Não pule frames; agrupe frames idênticos.
> **Escreva** (Write) o relatório em `$SP/video-analysis/batch_NN.md` com as seções: `### Telas observadas` (telas distintas + range de frames), `### Narrativa cronológica` (passo a passo citando o frame de cada ação — campos preenchidos e valores legíveis, cliques, navegação, modais, erros/sucesso, loading, validações), `### Detalhes de UI` (labels/placeholders/títulos/mensagens literais), `### Fricções` (problemas de UX visíveis; "nenhuma" se não houver).
> Seja factual — só o que VÊ. **Retorne APENAS**: `batch_NN OK: <2 telas principais> | <N fricções>`. Nada além disso.

Se um agente falhar, anotar quais segundos ficaram sem cobertura — **proibido fingir cobertura total** (ver regra de retorno parcial abaixo).

## Passo 5 — Síntese (1 subagente faz a leitura pesada)

Quando os lotes e a transcrição terminarem, disparar **UM** subagente `general-purpose` de síntese:

> Leia (Read) `$SP/video-analysis/transcript.txt` e TODOS os `$SP/video-analysis/batch_*.md`. A transcrição é a INTENÇÃO do autor (o que ele quer/critica); os frames CONFIRMAM e revelam bugs extras. Cruze os dois.
> **Retorne o relatório COMPLETO no texto da resposta** (o write em arquivo pode ser bloqueado pra subagente — não depender dele; o Claude principal persiste). O relatório deve começar pelo resumo executivo (≤25 linhas) neste formato fixo:
>
> **1. O que foi falado** — 2-4 bullets do que a narração diz (ou "vídeo sem áudio/narração").
> **2. Houve problemática?** — Sim/Não + 1 frase.
> **3. Problema central** — o ponto mais repetido/enfatizado na narração, com a citação literal + os frames que confirmam.
> **4. Pontos a corrigir/alterar** — lista priorizada, cada item marcado `[BUG]` ou `[MELHORIA]`, com **evidência** (`frame NNN` e/ou `transcript:linha`).
> **5. Cobertura** — segundos analisados / total; o que ficou de fora (se algo).
>
> Toda alegação precisa de evidência (frame ou linha da transcrição). Sem preâmbulo, sem prosa fora do formato.

## Passo 6 — Devolver ao user

O Claude principal **persiste o relatório retornado em `$SP/video-analysis/REPORT.md`** (com Write — o principal tem permissão; o subagente pode não ter) e **repassa só o resumo executivo** + os caminhos do `REPORT.md` e do `transcript.txt`. Não re-ler os batch files no contexto principal.

Oferecer próximo passo: virar **ADR** (skill `adr-writing`), **lista de tasks** priorizada, ou localizar no código os pontos citados.

---

## Regras obrigatórias (alinhadas ao CLAUDE.md global)

1. **Evidência, não afirmação** — todo ponto do relatório cita `frame NNN` e/ou `transcript:linha`. Sem evidência, o ponto não entra.
2. **Não poluir contexto principal** — batch agents escrevem em arquivo e retornam 1 linha; a leitura pesada é do agente de síntese. O principal vê só o resumo executivo.
3. **Output estruturado** — formato fixo do Passo 5, sem introdução/resumo extra.
4. **Retorno parcial permitido** — se lotes falharam, reportar a cobertura real (ex: "analisados 0–525s de 725s; 526–600 falhou"). Proibido alegar cobertura total que não houve.
5. **Exclusões duras** — vídeo > 30 min exige confirmação; sem faixa de áudio → sem seção "O que foi falado" (declarar explicitamente); fonte ClickUp sem anexo de vídeo → parar e avisar.

## Notas

- Scratchpad é por-sessão (frames/áudio somem depois); só o modelo whisper em `~/.cache/whisper-cpp/` persiste.
- Para vídeo de UX, **a narração costuma valer mais que a imagem** — é um review falado. Priorizar o que o autor diz e usar os frames pra confirmar/ampliar.
- Memória relacionada: `feedback_video_analysis_pipeline`.
