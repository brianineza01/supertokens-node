/**
 * Explicit SuperTokens + Hono integration.
 *
 * Requires: supertokens.init({ framework: "custom", ... })
 *
 * @example
 * ```ts
 * import { Hono } from "hono";
 * import { createAuthRoutes, verifySession, errorHandler } from "./integrations/hono";
 *
 * ensureSuperTokensInit();
 *
 * const app = new Hono();
 *
 * app.route("/auth", createAuthRoutes({
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
 * }));
 *
 * app.get("/sessioninfo", verifySession(), (c) =>
 *   c.json({ userId: c.req.session!.getUserId() })
 * );
 * app.onError(errorHandler());
 * ```
 */

import { Hono } from "hono";
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
    /** Return a Response to short-circuit (e.g. rate limiting). */
    beforeHandle?: (c: Context) => Promise<Response | undefined | void>;
    /** Transform the SuperTokens response (e.g. cache headers). */
    afterHandle?: (c: Context, response: Response) => Response | Promise<Response>;
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

/** Same as `getAppDirRequestHandler()` from `supertokens-node/nextjs`. */
export function getAuthRequestHandler(): AuthRequestHandler {
    return handleAuthAPIRequest();
}

export async function handleAuthRequest(c: Context): Promise<Response> {
    return getAuthRequestHandler()(c.req.raw);
}

/**
 * Returns a Hono app that handles all SuperTokens auth/API routes.
 * Mount it with `app.route("/auth", createAuthRoutes(handlers))`.
 */
export function createAuthRoutes(handlers?: AuthRouteHandlerOptions): Hono {
    const handleCall = getAuthRequestHandler();

    const auth = new Hono();

    auth.all("/*", async (c) => {
        if (handlers?.beforeHandle) {
            const earlyResponse = await handlers.beforeHandle(c);
            if (earlyResponse !== undefined) {
                return earlyResponse;
            }
        }

        let response = await handleCall(c.req.raw);

        if (handlers?.afterHandle) {
            response = await handlers.afterHandle(c, response);
        }

        return response;
    });

    return auth;
}

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

export async function withPreParsedRequestResponse(
    c: Context,
    handler: (request: PreParsedRequest, response: CollectingResponse) => Promise<Response>
): Promise<Response> {
    return customWithPreParsedRequestResponse(c.req.raw, handler);
}

export async function withSession(
    c: Context,
    handler: (error: Error | undefined, session: SessionContainer | undefined) => Promise<Response>,
    options?: VerifySessionOptions,
    userContext?: Record<string, unknown>
): Promise<Response> {
    return customWithSession(c.req.raw, handler, options, userContext);
}

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
