import { useApi } from "./api";
import { useEffect, useRef, useState } from "react";
import { COMMAND_TEXT_LIMIT, VOICE_SECONDS } from "@heedwork/core";
import type { CommandResult } from "@heedwork/core";
import { voiceAvailable, voiceTranscript } from "./command-voice";
import { useAction } from "./workspace-controls";
import type { SaveMutation } from "./workspace-controls";

export function Microphone() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
    >
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11v1a7 7 0 0 0 14 0v-1m-7 8v3m-3 0h6" />
    </svg>
  );
}

export function useCommandBar(
  save: SaveMutation,
  transcription: boolean,
  visible: boolean,
) {
  const { postJson, requestJson } = useApi();
  const [draft, setDraft] = useState("");
  const [summary, setSummary] = useState("");
  const [undoId, setUndoId] = useState<string>();
  const [voice, setVoice] = useState<"listening" | "transcribing">();
  const [voiceError, setVoiceError] = useState("");
  const [request, setRequest] = useState<{
    original: string;
    replies: string[];
  }>();
  const [clarificationTooLong, setClarificationTooLong] = useState(false);
  const [preferRecording, setPreferRecording] = useState(false);
  const recording = useRef<{
    stopped: AbortController;
    cancelled: AbortController;
  } | null>(null);
  const action = useAction();
  const [undoing, setUndoing] = useState(false);

  useEffect(
    () => () => {
      recording.current?.cancelled.abort();
      recording.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!visible) recording.current?.cancelled.abort();
  }, [visible]);

  function startVoice() {
    if (recording.current || action.busy) return;
    const stopped = new AbortController();
    const cancelled = new AbortController();
    recording.current = { stopped, cancelled };
    setVoiceError("");
    setVoice("listening");
    const timer = window.setTimeout(
      () => stopped.abort(),
      VOICE_SECONDS * 1000,
    );
    void voiceTranscript({
      fallback: transcription,
      requestJson,
      preferRecording,
      stopped: stopped.signal,
      cancelled: cancelled.signal,
      onTranscribing: () => setVoice("transcribing"),
      onFallback: () => setPreferRecording(true),
    })
      .then((text) => {
        if (cancelled.signal.aborted) return;
        if (text.trim()) setDraft(text.trim().slice(0, COMMAND_TEXT_LIMIT));
        else
          setVoiceError("No speech detected. Try again or type your command.");
      })
      .catch((cause: unknown) => {
        if (!cancelled.signal.aborted) {
          setVoiceError(
            cause instanceof Error
              ? cause.message
              : "Could not capture speech.",
          );
        }
      })
      .finally(() => {
        clearTimeout(timer);
        if (recording.current?.cancelled === cancelled) {
          recording.current = null;
          setVoice(undefined);
        }
      });
  }

  function stopVoice() {
    recording.current?.stopped.abort();
  }

  function cancelVoice() {
    recording.current?.cancelled.abort();
  }

  function submit() {
    const input = draft.trim();
    if (!input || voice || action.busy) return;
    const original = request?.original ?? input;
    const replies = request
      ? [
          ...request.replies,
          `Clarifying question: ${summary}\nUser's answer: ${input}`,
        ]
      : [];
    const text = request
      ? [`Original request: ${original}`, ...replies].join("\n")
      : input;
    if (request && text.length > COMMAND_TEXT_LIMIT) {
      setClarificationTooLong(true);
      return;
    }
    void action.run(async () => {
      setClarificationTooLong(false);
      setVoiceError("");
      const result = await postJson<CommandResult>("/api/command", { text });
      setDraft("");
      setSummary(
        result.refusal && !result.summary.includes(result.refusal.message)
          ? `${result.summary} ${result.refusal.message}`
          : result.summary,
      );
      setRequest(result.needsClarification ? { original, replies } : undefined);
      if (result.changes.length) setUndoId(result.undoId);
    });
  }

  function undo() {
    if (!undoId || action.busy || voice) return;
    setUndoing(true);
    setVoiceError("");
    void action
      .run(async () => {
        await save(
          { type: "UNDO_COMMAND", input: { id: undoId } },
          { callerReportsError: true },
        );
        setUndoId(undefined);
        setRequest(undefined);
        setClarificationTooLong(false);
        setSummary("Command undone.");
      })
      .finally(() => setUndoing(false));
  }

  function newCommand() {
    setRequest(undefined);
    setClarificationTooLong(false);
    setSummary("");
  }

  return {
    clarification: Boolean(request),
    clarificationTooLong,
    draft,
    setDraft,
    summary,
    undoId,
    voice,
    voiceError,
    action,
    undoing,
    startVoice,
    stopVoice,
    cancelVoice,
    newCommand,
    submit,
    undo,
    microphone: voiceAvailable(transcription),
  };
}

export function CommandBar({
  command,
  live,
  enabled,
}: {
  command: ReturnType<typeof useCommandBar>;
  live: boolean;
  enabled: boolean;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (
      live &&
      enabled &&
      window.matchMedia?.("(min-width: 761px)").matches &&
      document.activeElement === document.body
    )
      input.current?.focus({ preventScroll: true });
  }, [live, enabled]);
  const { voice, action, undoing } = command;
  const busy = action.busy || Boolean(voice);
  const message = action.busy
    ? undoing
      ? "Undoing…"
      : "Working…"
    : voice === "listening"
      ? "Listening…"
      : voice === "transcribing"
        ? "Transcribing…"
        : command.summary;
  const error = command.clarificationTooLong
    ? `This request and its answers exceed ${COMMAND_TEXT_LIMIT} characters. Shorten your answer or use New command to restate the complete request.`
    : command.voiceError || action.error;
  return (
    <div className="command-bar">
      <div
        className="command-feedback"
        hidden={!message && !error && !command.undoId}
      >
        {error && <p role="alert">{error}</p>}
        <p role="status">{message}</p>
        {command.clarification && (
          <button
            type="button"
            className="subtle"
            disabled={busy}
            onClick={command.newCommand}
          >
            New command
          </button>
        )}
        {command.undoId && (
          <button
            type="button"
            className="subtle"
            disabled={!enabled || !live || busy}
            onClick={command.undo}
          >
            Undo
          </button>
        )}
      </div>

      <form
        className="command-controls"
        onSubmit={(event) => {
          event.preventDefault();
          if (live) command.submit();
        }}
      >
        <span className="command-prompt" aria-hidden="true">
          ›
        </span>
        {enabled && command.microphone && (
          <button
            type="button"
            className="subtle command-mic"
            aria-label="Hold to speak"
            title="Hold to speak"
            aria-pressed={voice === "listening"}
            disabled={!live || action.busy || voice === "transcribing"}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              command.startVoice();
            }}
            onLostPointerCapture={command.stopVoice}
            onPointerUp={command.stopVoice}
            onPointerCancel={command.cancelVoice}
            onClick={(event) => {
              // Keyboard and assistive technology can toggle recording.
              if (event.detail !== 0) return;
              if (voice) command.stopVoice();
              else command.startVoice();
            }}
          >
            <Microphone />
          </button>
        )}
        <textarea
          ref={input}
          aria-label="Workspace command"
          rows={1}
          enterKeyHint="send"
          placeholder={
            !enabled
              ? "Workspace commands unavailable"
              : command.clarification
                ? "Answer the question…"
                : "Tell Heed what to change…"
          }
          value={command.draft}
          maxLength={COMMAND_TEXT_LIMIT}
          autoComplete="off"
          disabled={!enabled || !live || busy}
          onChange={(event) => command.setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !event.nativeEvent.isComposing) {
              event.currentTarget.blur();
            }
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        {enabled && (
          <button
            className="text-control command-send"
            disabled={!live || busy || !command.draft.trim()}
          >
            Send
          </button>
        )}
      </form>
    </div>
  );
}

export function ModelKeyHint() {
  return (
    <p className="muted">
      Configure Workers AI or an Anthropic key to enable workspace commands.
    </p>
  );
}
