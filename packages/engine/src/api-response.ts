import type { LimitError } from "./seams.js";

export function apiError(status: number, code: string, message: string) {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export function workspaceOperationError(error: unknown) {
  if (error instanceof URIError) {
    return {
      status: 400,
      code: "invalid_input",
      message: "Invalid path identifier",
    };
  }
  const message = error instanceof Error ? error.message : "";
  if (
    [
      "Item not found",
      "Project not found",
      "Token not found",
      "Verdict not found",
    ].includes(message)
  ) {
    return { status: 404, code: "not_found", message };
  }
  if (message.includes("UNIQUE constraint failed: projects.name")) {
    return {
      status: 409,
      code: "conflict",
      message: "A project with that name already exists",
    };
  }
  if (
    message.includes("Undo is unavailable.") ||
    message === "This command is no longer available to undo." ||
    message.startsWith("This can no longer be undone.") ||
    message.startsWith("Inbox cannot ") ||
    message === "Project still has items" ||
    message === "Item has no open handoff to answer" ||
    message.startsWith("Use reopenItem ") ||
    message.startsWith("Only done or cancelled items ") ||
    message.startsWith("Cannot add a dependency for cancelled item ") ||
    message.includes("would create a cycle") ||
    message.includes("would create an item cycle")
  ) {
    return { status: 409, code: "conflict", message };
  }
  if (
    message === "Default project not found" ||
    message.startsWith("Items cannot exceed depth ")
  ) {
    return { status: 400, code: "invalid_input", message };
  }
  console.error("Workspace operation failed", error);
  return {
    status: 500,
    code: "internal_error",
    message: "Workspace operation failed",
  };
}

export function limitResponse(error: LimitError) {
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (error.retryAfter !== undefined)
    headers.set("Retry-After", String(error.retryAfter));
  return Response.json(
    { error: error.detail },
    { status: error.status, headers },
  );
}
