/**
 * Content negotiation for form-post action routes. One endpoint serves two callers: a plain no-JS
 * <form> POST that wants a 303 redirect, and a progressive-enhancement `fetch` (or a script) that wants
 * JSON. The convention, including the `X-Requested-With: fetch` signal the enhancement scripts send,
 * lives here, along with the request body reader and the one `no-store` header every cart and purge
 * response uses.
 */

function isJsonBody(request: Request): boolean {
  return request.headers.get('content-type')?.toLowerCase().includes('application/json') === true;
}

/**
 * True when the caller is a `fetch` or a script expecting JSON rather than a navigating <form> wanting
 * the 303: it asks for JSON, sends `X-Requested-With: fetch`, or posts a JSON body.
 */
export function wantsJson(request: Request): boolean {
  return (
    request.headers.get('accept')?.includes('application/json') === true ||
    request.headers.get('x-requested-with') === 'fetch' ||
    isJsonBody(request)
  );
}

/** A JSON Response, built explicitly (not Response.json) so it types cleanly under the Workers lib. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * Mark a response as never to be stored by a shared cache. The one place this header is set: anything
 * carrying the visitor's cart (the cart view holds Shopify's checkout URL) or answering a purge.
 */
export function noStore(response: Response): Response {
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}

/** A JSON Response marked {@link noStore}. */
export function privateJson(body: unknown, status = 200): Response {
  return noStore(jsonResponse(body, status));
}

/** The 400 for a request body that cannot be read at all (not a form, or JSON that is not an object). */
export function unreadableBodyResponse(): Response {
  return jsonResponse({ error: 'The request body could not be read.' }, 400);
}

/**
 * Read a POST body as `FormData`, whether it was sent as a form or as JSON (by Content-Type). A JSON
 * body must be an object; its string and number values become fields, anything else is left out so
 * the field validators reject it. Resolves `null` when the body cannot be read.
 */
export async function readFormBody(request: Request): Promise<FormData | null> {
  try {
    if (!isJsonBody(request)) return await request.formData();
    const body: unknown = await request.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
    const form = new FormData();
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === 'string' || typeof value === 'number') form.set(key, String(value));
    }
    return form;
  } catch {
    return null;
  }
}
