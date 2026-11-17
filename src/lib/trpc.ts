import http, { RefinedResponse, ResponseType } from "k6/http";
import { config, DENY_LIST } from "./config.ts";

export type ProcedureType = "query" | "mutation";

export interface CallOptions {
  /** HTTP statuses that are an expected outcome and not a failure. */
  expected?: number[];
}

// 200 is always fine. Anything in `expected` is an acceptable business error
// (e.g. 404 "not in a team"), so it isn't counted as a failed request.
function callbackFor(expected: number[]) {
  return http.expectedStatuses(200, ...expected);
}

/**
 * Calls a tRPC procedure over plain HTTP (no batching).
 * Queries: GET ?input=<json>. Mutations: POST body. Input is wrapped in the
 * superjson envelope `{ json: <value> }`.
 */
export function trpc(
  path: string,
  type: ProcedureType,
  input?: unknown,
  opts: CallOptions = {},
): RefinedResponse<ResponseType> | null {
  if (DENY_LIST.has(path)) return null;
  if (type === "mutation" && !config.allowMutations) return null;

  const params = {
    tags: { name: path, procedure: path, type },
    headers: { "content-type": "application/json" },
    responseCallback: callbackFor(opts.expected ?? []),
  };
  const url = `${config.target}/api/trpc/${path}`;

  if (type === "query") {
    const qs =
      input === undefined
        ? ""
        : `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
    return http.get(url + qs, params);
  }
  const body = input === undefined ? undefined : JSON.stringify({ json: input });
  return http.post(url, body, params);
}
