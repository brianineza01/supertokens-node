/**
 * Explicit SuperTokens + Hono integration.
 *
 * Auth endpoints are NOT registered automatically. You mount them yourself,
 * the same way Next.js App Router exports GET/POST/... on an auth route file.
 *
 * Requires: supertokens.init({ framework: "custom", ... })
 *
 * @example
 * ```ts
 * import { Hono } from "hono";
 * import { createAuthRouteHandlers, verifySession } from "./integrations/hono";
 *
 * ensureSuperTokensInit();
 *
 * // --- auth routes (you control the mount path and middleware) ---
 * const auth = new Hono();
 *
 * const handlers = createAuthRouteHandlers({
 *   beforeHandle: async (c) => {
 *     const rateLimitError = await rateLimitMiddleware(c.req.raw);
 *     if (rateLimitError) return rateLimitErrorToResponse(rateLimitError);
 *   },
 *   afterHandle: (_c, res) => {
 *     if (!res.headers.has("Cache-Control")) {
 *       res.headers.set("Cache-Control", "no-cache, no-store, max-age=0, must-revalidate");
 *     }
 *     return res;
 *   },
 * });
 *
 * auth.get("/*", handlers.GET);
 * auth.post("/*", handlers.POST);
 * auth.delete("/*", handlers.DELETE);
 * auth.put("/*", handlers.PUT);
 * auth.patch("/*", handlers.PATCH);
 * auth.head("/*", handlers.HEAD);
 *
 * app.route("/auth", auth); // only /auth/* hits SuperTokens
 *
 * // --- protected API routes (separate, explicit) ---
 * app.get("/sessioninfo", verifySession(), (c) =>
 *   c.json({ userId: c.req.session!.getUserId() })
 * );
 * app.onError(errorHandler());
 * ```
 */

import type { Context, ErrorHandler, MiddlewareHandler, Next } from "hono";
import { getCookie } from "hono/cookie";
import { serialize } from "cookie";
import {
    handleAuthAPIRequest,
    withPreParsedRequestResponse as customWithPreParsedRequestResponse,
    withSession as customWithSession,
} from "supertokens-node/custom";
import {
    CollectingResponse,
    PreParsedRequest,
    errorHandler as supertokensCustomErrorHandler,
} from "supertokens-node/framework/custom";
import { verifySession as customVerifySession } from "supertokens-node/recipe/session/framework/custom";
import type { VerifySessionOptions, SessionContainer } from "supertokens-node/recipe/session";
import type { HTTPMethod } from "supertokens-node/types";

const ST_REQUEST_KEY = "supertokens:request";
const ST_RESPONSE_KEY = "supertokens:collectingResponse";

export type AuthRequestHandler = (request: Request) => Promise<Response>;

export type AuthRouteHandlerOptions = {
    /**
     * Runs before SuperTokens handles the request.
     * Return a Response to short-circuit (e.g. rate limiting).
     */
    beforeHandle?: (c: Context) => Promise<Response | undefined | void>;
    /**
     * Runs after SuperTokens returns a response.
     * Use for cache headers, logging, etc.
     */
    afterHandle?: (c: Context, response: Response) => Response | Promise<Response>;
};

export type AuthRouteHandlers = {
    GET: MiddlewareHandler;
    POST: MiddlewareHandler;
    PUT: MiddlewareHandler;
    PATCH: MiddlewareHandler;
    DELETE: MiddlewareHandler;
    HEAD: MiddlewareHandler;
    OPTIONS: MiddlewareHandler;
};

function setCookiesInHeaders(headers: Headers, cookies: CollectingResponse["cookies"]): void {
    for (const cookie of cookies) {
        headers.append(
            "Set-Cookie",
            serialize(cookie.key, cookie.value, {
                domain: cookie.domain,
                expires: new Date(cookie.expires),
                httpOnly: cookie.httpOnly,
                path: cookie.path,
                sameSite: cookie.sameSite,
                secure: cookie.secure,
            })
        );
    }
}

function copyHeaders(source: Headers, destination: Headers): void {
    for (const [key, value] of source.entries()) {
        destination.append(key, value);
    }
}

function toWebResponse(collectingResponse: CollectingResponse): Response {
    const headers = new Headers(collectingResponse.headers);
    setCookiesInHeaders(headers, collectingResponse.cookies);

    return new Response(collectingResponse.body, {
        status: collectingResponse.statusCode,
        headers,
    });
}

function mergeCollectingResponseIntoHonoResponse(
    honoResponse: Response,
    collectingResponse: CollectingResponse
): Response {
    setCookiesInHeaders(honoResponse.headers, collectingResponse.cookies);
    copyHeaders(collectingResponse.headers, honoResponse.headers);
    return honoResponse;
}

function getRequestUrl(c: Context): string {
    const url = new URL(c.req.url);
    return url.pathname + url.search;
}

function storeContext(c: Context, request: PreParsedRequest, response: CollectingResponse): void {
    c.set(ST_REQUEST_KEY, request);
    c.set(ST_RESPONSE_KEY, response);
}

function getStoredRequest(c: Context): PreParsedRequest {
    return c.get(ST_REQUEST_KEY) ?? wrapHonoRequest(c);
}

function getStoredCollectingResponse(c: Context): CollectingResponse {
    return c.get(ST_RESPONSE_KEY) ?? new CollectingResponse();
}

/**
 * Returns a handler for SuperTokens auth/API requests.
 * Equivalent to `getAppDirRequestHandler()` from `supertokens-node/nextjs`.
 *
 * Pass it a standard Web `Request` — in Hono that is `c.req.raw`.
 */
export function getAuthRequestHandler(): AuthRequestHandler {
    return handleAuthAPIRequest();
}

/**
 * Handles a single auth/API request from a Hono context.
 * Use this when you want one explicit route handler function.
 */
export async function handleAuthRequest(c: Context): Promise<Response> {
    return getAuthRequestHandler()(c.req.raw);
}

/**
 * Creates explicit HTTP method handlers for a dedicated auth route file.
 * Wire each method to the paths you control — nothing is registered automatically.
 *
 * Equivalent to exporting GET/POST/DELETE/... from a Next.js App Router auth route.
 */
export function createAuthRouteHandlers(options?: AuthRouteHandlerOptions): AuthRouteHandlers {
    const handleCall = getAuthRequestHandler();

    const handler: MiddlewareHandler = async (c) => {
        if (options?.beforeHandle) {
            const earlyResponse = await options.beforeHandle(c);
            if (earlyResponse !== undefined) {
                return earlyResponse;
            }
        }

        let response = await handleCall(c.req.raw);

        if (options?.afterHandle) {
            response = await options.afterHandle(c, response);
        }

        return response;
    };

    return {
        GET: handler,
        POST: handler,
        PUT: handler,
        PATCH: handler,
        DELETE: handler,
        HEAD: handler,
        OPTIONS: handler,
    };
}

/**
 * Wraps a Hono context into SuperTokens' custom-framework request type.
 */
export function wrapHonoRequest(c: Context): PreParsedRequest {
    return new PreParsedRequest({
        method: c.req.method as HTTPMethod,
        url: getRequestUrl(c),
        query: c.req.query(),
        cookies: getCookie(c),
        headers: c.req.raw.headers,
        getFormBody: () => c.req.parseBody(),
        getJSONBody: () => c.req.json(),
    });
}

export function wrapHonoResponse(): CollectingResponse {
    return new CollectingResponse();
}

/**
 * Run custom logic with SuperTokens request/response wrappers.
 * Equivalent to `withPreParsedRequestResponse` from `supertokens-node/custom`.
 */
export async function withPreParsedRequestResponse(
    c: Context,
    handler: (request: PreParsedRequest, response: CollectingResponse) => Promise<Response>
): Promise<Response> {
    return customWithPreParsedRequestResponse(c.req.raw, handler);
}

/**
 * Run a handler with an optional session attached.
 * Equivalent to `withSession` from `supertokens-node/custom`.
 */
export async function withSession(
    c: Context,
    handler: (error: Error | undefined, session: SessionContainer | undefined) => Promise<Response>,
    options?: VerifySessionOptions,
    userContext?: Record<string, unknown>
): Promise<Response> {
    return customWithSession(c.req.raw, handler, options, userContext);
}

/**
 * Protects a route by verifying the session.
 * Register only on routes you choose — not on auth routes.
 */
export function verifySession(options?: VerifySessionOptions): MiddlewareHandler {
    return async (c: Context, next: Next) => {
        const request = wrapHonoRequest(c);
        const collectingResponse = new CollectingResponse();
        const statusBefore = collectingResponse.statusCode;
        const bodyBefore = collectingResponse.body;

        storeContext(c, request, collectingResponse);

        const verifyError = await customVerifySession(options)(request, collectingResponse);

        if (verifyError !== undefined) {
            throw verifyError;
        }

        if (collectingResponse.body !== bodyBefore || collectingResponse.statusCode !== statusBefore) {
            return toWebResponse(collectingResponse);
        }

        c.req.session = request.session;

        await next();

        return mergeCollectingResponseIntoHonoResponse(c.res, collectingResponse);
    };
}

/**
 * Global error handler for session-related SuperTokens errors on protected routes.
 * Register with `app.onError(errorHandler())`.
 */
export function errorHandler(): ErrorHandler {
    const stErrorHandler = supertokensCustomErrorHandler();

    return async (err: Error, c: Context) => {
        const request = getStoredRequest(c);
        const collectingResponse = getStoredCollectingResponse(c);

        await stErrorHandler(err, request, collectingResponse, () => {
            throw err;
        });

        return toWebResponse(collectingResponse);
    };
}

declare module "hono" {
    interface HonoRequest {
        session?: SessionContainer;
    }
}
