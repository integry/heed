import { createContext, useContext, useEffect, useState } from "react";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function createApi(
  onUnauthorized?: () => void,
  scopeSignal?: AbortSignal,
) {
  async function requestJson<T>(
    path: string,
    init: RequestInit,
    fallback = "The request failed. Try again.",
  ): Promise<T> {
    const signal =
      scopeSignal && init.signal
        ? (AbortSignal.any?.([scopeSignal, init.signal]) ?? init.signal)
        : (scopeSignal ?? init.signal);
    scopeSignal?.throwIfAborted();
    signal?.throwIfAborted();
    const response = await fetch(
      path,
      scopeSignal ? { ...init, signal } : init,
    );
    scopeSignal?.throwIfAborted();
    signal?.throwIfAborted();
    if (response.status === 401) onUnauthorized?.();
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const error = body?.error;
      const message = error?.reason ?? error?.message ?? error;
      throw new ApiError(
        typeof message === "string" ? message : fallback,
        response.status,
        typeof error?.code === "string" ? error.code : undefined,
      );
    }
    if (response.status === 204) return undefined as T;
    return response.json();
  }

  function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
    return requestJson<T>(
      path,
      { signal, cache: "no-store" },
      "Couldn’t load the requested data.",
    );
  }

  function postJson<T>(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    return requestJson<T>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  }

  return { getJson, postJson, requestJson };
}

const defaultApi = createApi();
export const { getJson, postJson } = defaultApi;
export const ApiContext = createContext(defaultApi);

export function useApi() {
  return useContext(ApiContext);
}

export interface Resource<T> {
  data?: T;
  error?: Error;
  loading: boolean;
  reload: () => void;
}

export function useResource<T>(
  path: string | null,
  revision?: unknown,
): Resource<T> {
  const { getJson } = useApi();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    path: string;
    revision: unknown;
    attempt: number;
    data?: T;
    error?: Error;
  }>();
  useEffect(() => {
    if (path === null) return;
    const controller = new AbortController();
    void getJson<T>(path, controller.signal).then(
      (data) => {
        if (!controller.signal.aborted)
          setResult({ path, revision, attempt, data });
      },
      (error: Error) => {
        if (!controller.signal.aborted)
          setResult({ path, revision, attempt, error });
      },
    );
    return () => controller.abort();
  }, [getJson, path, revision, attempt]);

  const current = result?.path === path ? result : undefined;
  const settled =
    current &&
    Object.is(current.revision, revision) &&
    current.attempt === attempt;
  return {
    data: current?.data,
    error: current?.error,
    loading: path !== null && !settled,
    reload: () => setAttempt((value) => value + 1),
  };
}

export interface ApiHelpers {
  getJson: typeof getJson;
  postJson: typeof postJson;
  useResource: typeof useResource;
}
