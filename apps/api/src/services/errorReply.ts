// What a request that failed inside the service is told.
//
// A client error (a malformed body, a bad parameter) is answered with the error's
// own words: they describe the request, and the caller needs them to fix it. A
// failure inside the service is not: its message can carry a file path, a user
// name, a line of a stack, or whatever a library put in it, and none of that is
// the caller's to see. The caller gets one sentence; the details go to the
// service's log, where the person running it can read them.

export type ErrorReply = { status: number; code: "REQUEST_ERROR" | "INTERNAL_ERROR"; message: string };

export const internalErrorMessage = "Something went wrong inside TRH AI's service. The details are in its log.";

export function errorReply(error: { status?: unknown; statusCode?: unknown; message?: unknown }): ErrorReply {
  // body-parser's errors carry both; Express 5's router marks a malformed URL
  // parameter with `status` alone. A code that is not a client or server error is
  // no status to answer with.
  const given = error.statusCode ?? error.status;
  const status = typeof given === "number" && Number.isInteger(given) && given >= 400 && given < 600 ? given : 500;
  if (status >= 500) return { status, code: "INTERNAL_ERROR", message: internalErrorMessage };
  return { status, code: "REQUEST_ERROR", message: typeof error.message === "string" && error.message ? error.message : "The request could not be read." };
}
