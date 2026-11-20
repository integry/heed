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
  if (message === "Item not found" || message === "Project not found") {
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
    message.startsWith("Inbox cannot ") ||
    message === "Project still has items" ||
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
