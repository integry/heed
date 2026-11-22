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
  model: boolean,
  execute: (text: string) => Promise<string | undefined>,
) {
  const { postJson, requestJson } = useApi();
  const line = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const [summary, setSummary] = useState("");
  const [undoId, setUndoId] = useState<string>();
  const [voice, setVoice] = useState<"listening" | "transcribing">();
  const [voiceError, setVoiceError] = useState("");
  const [request, setRequest] = useState<{
    original: string;
    replies: string[];
    question: string;
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

  function submit(value = draft) {
    const input = value.trim();
    if (!input || voice || action.busy) return;
    void action.run(async () => {
      setClarificationTooLong(false);
      setVoiceError("");
      if (!request) {
        const local = await execute(input);
        if (local !== undefined) {
          setDraft("");
          setSummary(local);
          return;
        }
        if (!model) return;
      }
      const original = request?.original ?? input;
      const replies = request
        ? [
            ...request.replies,
            `Clarifying question: ${request.question}\nUser's answer: ${input}`,
          ]
        : [];
      const text = request
        ? [`Original request: ${original}`, ...replies].join("\n")
        : input;
      if (text.length > COMMAND_TEXT_LIMIT) {
        setClarificationTooLong(true);
        return;
      }
      const result = await postJson<CommandResult>("/api/command", { text });
      setDraft("");
      setSummary(
        result.refusal && !result.summary.includes(result.refusal.message)
          ? `${result.summary} ${result.refusal.message}`
          : result.summary,
      );
      setRequest(
        result.needsClarification
          ? { original, replies, question: result.summary }
          : undefined,
      );
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
    line,
    setSummary,
    clarification: Boolean(request),
    clarificationTooLong,
    draft,
    setDraft,
    summary: request?.question ?? summary,
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
  replyName,
  exitReply,
}: {
  command: ReturnType<typeof useCommandBar>;
  live: boolean;
  replyName?: string;
  exitReply: () => void;
}) {
  const input = command.line;
  useEffect(() => {
    if (
      window.matchMedia?.("(min-width: 761px)").matches &&
      document.activeElement === document.body
    )
      input.current?.focus({ preventScroll: true });
  }, [input]);
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
        hidden={!message && !error && !command.undoId && !replyName}
      >
        {error && (
          <p role="alert" title={error}>
            {error}
          </p>
        )}
        {(!error || command.clarification) && (
          <p role="status" title={message}>
            {message}
          </p>
        )}
        {replyName && (
          <button type="button" className="text-control" onClick={exitReply}>
            Exit reply
          </button>
        )}
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
            disabled={!live || busy}
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
          command.submit();
        }}
      >
        <span className="command-prompt" aria-hidden="true">
          ›
        </span>
        {command.microphone && (
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
        <input
          ref={input}
          aria-label="Workspace command"
          enterKeyHint="send"
          placeholder={
            replyName
              ? `Reply to ${replyName}…`
              : command.clarification
                ? "Answer the question…"
                : "Tell Heed what to change…"
          }
          value={command.draft}
          maxLength={COMMAND_TEXT_LIMIT}
          autoComplete="off"
          readOnly={busy}
          onChange={(event) => command.setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !event.nativeEvent.isComposing) {
              if (replyName) exitReply();
              else event.currentTarget.blur();
            }
            if (event.key === "Enter" && event.nativeEvent.isComposing)
              event.preventDefault();
          }}
        />
        <button
          className="text-control command-send"
          disabled={busy || !command.draft.trim()}
        >
          Send
        </button>
      </form>
      {!replyName && !command.clarification && (
        <div className="command-examples" aria-label="Example commands">
          {[
            "what needs me?",
            "what is blocked?",
            "zoom into today",
            "edit guidance",
          ].map((example) => (
            <button
              key={example}
              type="button"
              disabled={!live || busy}
              onClick={() => command.submit(example)}
            >
              {example}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
