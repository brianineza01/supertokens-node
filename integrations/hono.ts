/**
 * Standalone SuperTokens + Hono integration (not part of the built-in framework adapters).
 *
 * Usage:
 *   import supertokens from "supertokens-node";
 *   import { Hono } from "hono";
 *   import { superTokensMiddleware, verifySession } from "./integrations/hono";
 *
 *   supertokens.init({ framework: "custom", /* ... */ });
 *
 *   const app = new Hono();
 *   app.use("*", superTokensMiddleware());
 *   app.get("/api", verifySession(), (c) => c.json({ userId: c.req.session!.getUserId() }));
 */

import type { Context, MiddlewareHandler, Next } from "hono";
import { getCookie } from "hono/cookie";
import { serialize } from "cookie";
import {
    CollectingResponse,
    PreParsedRequest,
    middleware as supertokensCustomMiddleware,
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

/**
 * Wraps a Hono context into SuperTokens' custom-framework request type.
 */
export function wrapHonoRequest(c: Context): PreParsedRequest {
    return new PreParsedRequest({
        method: c.req.method as HTTPMethod,
        url: c.req.url,
        query: Object.fromEntries(new URL(c.req.url).searchParams.entries()),
        cookies: getCookie(c),
        headers: c.req.raw.headers,
        getFormBody: () => c.req.formData(),
        getJSONBody: () => c.req.json(),
    });
}

function getStoredRequest(c: Context): PreParsedRequest {
    return c.get(ST_REQUEST_KEY) ?? wrapHonoRequest(c);
}

function getStoredCollectingResponse(c: Context): CollectingResponse {
    return c.get(ST_RESPONSE_KEY) ?? new CollectingResponse();
}

/**
 * Hono middleware that runs SuperTokens API routes and attaches an optional session to the request.
 */
export function superTokensMiddleware(): MiddlewareHandler {
    return async (c: Context, next: Next) => {
        const request = wrapHonoRequest(c);
        const collectingResponse = new CollectingResponse();

        c.set(ST_REQUEST_KEY, request);
        c.set(ST_RESPONSE_KEY, collectingResponse);

        const stMiddleware = supertokensCustomMiddleware(() => request);
        const { handled, error } = await stMiddleware(request, collectingResponse);

        if (error) {
            throw error;
        }

        if (handled) {
            return toWebResponse(collectingResponse);
        }

        try {
            c.req.session = await Session.getSession(request, collectingResponse, {
                sessionRequired: false,
            });

            await next();

            return mergeCollectingResponseIntoHonoResponse(c.res, collectingResponse);
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
    };
}

function hasCollectingResponsePayload(collectingResponse: CollectingResponse): boolean {
    return collectingResponse.body !== undefined || collectingResponse.cookies.length > 0;
}

/**
 * Hono middleware that verifies the session created by `superTokensMiddleware()`.
 */
export function verifySession(options?: VerifySessionOptions): MiddlewareHandler {
    return async (c: Context, next: Next) => {
        const request = getStoredRequest(c);
        const collectingResponse = getStoredCollectingResponse(c);

        const verifyError = await customVerifySession(options)(request, collectingResponse);

        if (verifyError !== undefined) {
            throw verifyError;
        }

        if (hasCollectingResponsePayload(collectingResponse)) {
            return toWebResponse(collectingResponse);
        }

        c.req.session = request.session;
        c.set(ST_REQUEST_KEY, request);

        await next();

        return mergeCollectingResponseIntoHonoResponse(c.res, collectingResponse);
    };
}

declare module "hono" {
    interface HonoRequest {
        session?: SessionContainer;
    }
}
