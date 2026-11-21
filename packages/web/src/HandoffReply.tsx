import { useState } from "react";
import { AnswerHandoffSchema, HandoffOptionsSchema } from "@heedwork/core";
import type { Item } from "@heedwork/core";
import { useAction, type SaveMutation } from "./workspace-controls";

export function HandoffReply({
  item,
  disabled,
  save,
}: {
  item: Item;
  disabled: boolean;
  save: SaveMutation;
}) {
  const [draft, setDraft] = useState<string>();
  const { run, error, busy } = useAction();
  const options = HandoffOptionsSchema.parse(
    JSON.parse(item.handoff_options ?? "[]"),
  );
  const text = draft?.trim() ?? "";
  const valid = AnswerHandoffSchema.shape.text.safeParse(text).success;

  function answer(text: string) {
    void run(() =>
      save(
        { type: "ANSWER_HANDOFF", input: { item_id: item.id, text } },
        { callerReportsError: true },
      ),
    );
  }

  return (
    <>
      <strong>
        {item.agent_name ? `${item.agent_name} asks` : "Needs input"}
      </strong>
      {item.handoff_note && <p>{item.handoff_note}</p>}
      <div className="handoff-replies">
        {options.map((option, index) => (
          <button
            key={index}
            type="button"
            className="subtle handoff-chip"
            disabled={disabled || busy}
            onClick={() => answer(option)}
          >
            {option}
          </button>
        ))}
        {draft === undefined && (
          <button
            type="button"
            className="subtle"
            disabled={disabled || busy}
            onClick={() => setDraft("")}
          >
            Type a reply
          </button>
        )}
      </div>
      {draft !== undefined && (
        <form
          className="handoff-reply-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) answer(text);
          }}
        >
          <textarea
            aria-label="Handoff reply"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={3}
            autoFocus
            disabled={disabled || busy}
          />
          <button
            type="submit"
            className="primary"
            disabled={disabled || busy || !valid}
          >
            Send reply
          </button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
    </>
  );
}
