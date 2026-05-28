/**
 * Standalone SuperTokens + Hono integration (outside the built-in framework adapters).
 *
 * Express equivalent:
 *   app.use(middleware());          // handles /auth/signup, /auth/signin, /auth/session/refresh, etc.
 *   app.get("/api", verifySession(), handler);
 *   app.onError(errorHandler());
 *
 * Hono equivalent:
 *   app.use("*", middleware());
 *   app.get("/api", verifySession(), handler);
 *   app.onError(errorHandler());
 *
 * Requires: supertokens.init({ framework: "custom", ... })
 */

import type { Context, ErrorHandler, MiddlewareHandler, Next } from "hono";
import { getCookie } from "hono/cookie";
import { serialize } from "cookie";
import {
    CollectingResponse,
    PreParsedRequest,
    middleware as supertokensCustomMiddleware,
    errorHandler as supertokensCustomErrorHandler,
} from "supertokens-node/framework/custom";
import { verifySession as customVerifySession } from "supertokens-node/recipe/session/framework/custom";
import type { VerifySessionOptions, SessionContainer } from "supertokens-node/recipe/session";
import Session from "supertokens-node/recipe/session";
import type { HTTPMethod } from "supertokens-node/types";

const ST_REQUEST_KEY = "supertokens:request";
const ST_RESPONSE_KEY = "supertokens:collectingResponse";

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
    // Hono exposes the full URL; SuperTokens normalises this to the pathname internally.
    // Include the query string so behaviour matches Express' originalUrl.
    const url = new URL(c.req.url);
    return url.pathname + url.search;
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

function getStoredRequest(c: Context): PreParsedRequest {
    return c.get(ST_REQUEST_KEY) ?? wrapHonoRequest(c);
}

function getStoredCollectingResponse(c: Context): CollectingResponse {
    return c.get(ST_RESPONSE_KEY) ?? new CollectingResponse();
}

function storeContext(c: Context, request: PreParsedRequest, response: CollectingResponse): void {
    c.set(ST_REQUEST_KEY, request);
    c.set(ST_RESPONSE_KEY, response);
}

/**
 * Handles all SuperTokens API routes (e.g. /auth/signup, /auth/signin, /auth/signout,
 * /auth/session/refresh). Non-auth routes pass through to the next handler.
 *
 * This is the direct Hono equivalent of `supertokens-node/framework/express` `middleware()`.
 */
export function middleware(): MiddlewareHandler {
    return async (c: Context, next: Next) => {
        const request = wrapHonoRequest(c);
        const collectingResponse = new CollectingResponse();
        storeContext(c, request, collectingResponse);

        const stMiddleware = supertokensCustomMiddleware(() => request);
        const { handled, error } = await stMiddleware(request, collectingResponse);

        if (error) {
            throw error;
        }

        if (handled) {
            // SuperTokens handled an auth/API route — return immediately, do not call next().
            return toWebResponse(collectingResponse);
        }

        return next();
    };
}

/**
 * Global error handler for session-related SuperTokens errors.
 * Register with `app.onError(errorHandler())` — place after your routes.
 *
 * Equivalent to `app.use(errorHandler())` in Express.
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

/**
 * Optional helper: attaches a session to `c.req.session` on every request without requiring it.
 * Use this if you want session available on all routes (similar to the Cloudflare Workers example).
 * Not required if you only use `verifySession()` on protected routes (Express-style).
 */
export function attachSession(): MiddlewareHandler {
    return async (c: Context, next: Next) => {
        const request = getStoredRequest(c);
        const collectingResponse = getStoredCollectingResponse(c);

        try {
            c.req.session = await Session.getSession(request, collectingResponse, {
                sessionRequired: false,
            });
        } catch (err) {
            if (Session.Error.isErrorFromSuperTokens(err)) {
                if (err.type === Session.Error.TRY_REFRESH_TOKEN || err.type === Session.Error.INVALID_CLAIMS) {
                    return new Response("Unauthorized", {
                        status: err.type === Session.Error.INVALID_CLAIMS ? 403 : 401,
                    });
                }
            }
            throw err;
        }

        await next();

        return mergeCollectingResponseIntoHonoResponse(c.res, collectingResponse);
    };
}

/**
 * Protects a route by verifying the session. Must run after `middleware()`.
 * Equivalent to `verifySession()` from `supertokens-node/recipe/session/framework/express`.
 */
export function verifySession(options?: VerifySessionOptions): MiddlewareHandler {
    return async (c: Context, next: Next) => {
        const request = getStoredRequest(c);
        const collectingResponse = getStoredCollectingResponse(c);
        const statusBefore = collectingResponse.statusCode;
        const bodyBefore = collectingResponse.body;

        const verifyError = await customVerifySession(options)(request, collectingResponse);

        if (verifyError !== undefined) {
            throw verifyError;
        }

        if (collectingResponse.body !== bodyBefore || collectingResponse.statusCode !== statusBefore) {
            return toWebResponse(collectingResponse);
        }

        c.req.session = request.session;
        storeContext(c, request, collectingResponse);

        await next();

        return mergeCollectingResponseIntoHonoResponse(c.res, collectingResponse);
    };
}

/** @deprecated Use `middleware()` — kept for backwards compatibility. */
export const superTokensMiddleware = middleware;

/** @deprecated Use `wrapHonoRequest()` — kept for backwards compatibility. */
export const wrapRequest = wrapHonoRequest;

/** @deprecated Use `wrapHonoResponse()` — kept for backwards compatibility. */
export const wrapResponse = wrapHonoResponse;

declare module "hono" {
    interface HonoRequest {
        session?: SessionContainer;
    }
}
