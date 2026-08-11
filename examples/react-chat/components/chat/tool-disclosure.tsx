import type { ToolState } from "@/lib/letta/transcript";
import styles from "@/styles/chat.module.css";

function formatToolInput(tool: ToolState) {
  const rawInput = tool.rawInput.trim();
  if (rawInput) {
    try {
      return JSON.stringify(JSON.parse(rawInput), null, 2);
    } catch {
      return tool.status === "running" ? "Receiving input…" : rawInput;
    }
  }
  return JSON.stringify(tool.input, null, 2);
}

export function ToolDisclosure({ tools }: { tools: ToolState[] }) {
  const status: ToolState["status"] = tools.some(
    (tool) => tool.status === "running",
  )
    ? "running"
    : tools.some((tool) => tool.status === "failed")
      ? "failed"
      : "complete";
  const names = [...new Set(tools.map((tool) => tool.name))];
  const label =
    tools.length === 1
      ? tools[0].name
      : names.length === 1
        ? `${names[0]} ×${tools.length}`
        : names.join(", ");
  const summary =
    status === "running"
      ? `${label}…`
      : status === "failed"
        ? `${label} failed`
        : label;

  return (
    <details className={styles.toolDisclosure}>
      <summary aria-label={`${label}, ${status}`}>{summary}</summary>
      <div className={styles.toolList}>
        {tools.map((tool) => (
          <div className={styles.toolItem} key={tool.id}>
            {tools.length > 1 && (
              <div className={styles.toolHeader}>{tool.name}</div>
            )}
            <pre>{formatToolInput(tool)}</pre>
          </div>
        ))}
      </div>
    </details>
  );
}
