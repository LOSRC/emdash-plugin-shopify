/**
 * Content negotiation for form-post action routes. One endpoint serves two callers: a plain no-JS
 * <form> POST that wants a 303 redirect, and a progressive-enhancement `fetch` that wants JSON. The
 * convention, including the `X-Requested-With: fetch` signal the enhancement scripts send, lives here.
 */

/** True when the caller is a `fetch` expecting JSON rather than a navigating <form> wanting the 303. */
export function wantsJson(request: Request): boolean {
  return (
    request.headers.get('accept')?.includes('application/json') === true ||
    request.headers.get('x-requested-with') === 'fetch'
  );
}

/** A JSON Response, built explicitly (not Response.json) so it types cleanly under the Workers lib. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
