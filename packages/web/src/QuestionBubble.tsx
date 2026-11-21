import { HandoffOptionsSchema, type Item } from "@heedwork/core";
import { useAction } from "./workspace-controls";

export function QuestionBubble({
  item,
  disabled,
  answer,
  typeReply,
}: {
  item: Item;
  disabled: boolean;
  answer: (text: string) => Promise<void>;
  typeReply: () => void;
}) {
  const { run, error, busy } = useAction();
  const options = HandoffOptionsSchema.parse(
    JSON.parse(item.handoff_options ?? "[]"),
  );
  return (
    <section
      className="field-question"
      aria-label={`Question about ${item.title}`}
    >
      <small>
        {item.agent_name ?? (item.created_by === "human" ? "You" : "Agent")}{" "}
        asks · {item.title}
      </small>
      {item.handoff_note && <p>{item.handoff_note}</p>}
      <div className="question-replies">
        {options.map((option, index) => (
          <button
            key={index}
            type="button"
            disabled={disabled || busy}
            onClick={() => void run(() => answer(option))}
          >
            {option}
          </button>
        ))}
        <button type="button" disabled={disabled || busy} onClick={typeReply}>
          Type a reply
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
