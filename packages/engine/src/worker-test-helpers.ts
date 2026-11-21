import { createExecutionContext } from "cloudflare:test";
import worker from "./worker";

export function fetchOpen(
  request: Request,
  env: Parameters<typeof worker.fetch>[1],
) {
  return worker.fetch(request, env, createExecutionContext());
}
