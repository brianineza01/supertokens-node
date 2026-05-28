/**
 * Example: mount SuperTokens auth at /auth
 *
 *   app.route("/auth", createAuthRoutes(handlers));
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { createAuthRoutes } from "./hono";

// ensureSuperTokensInit();

const handlers = {
    beforeHandle: async (_c: Context) => {
        // const rateLimitError = await rateLimitMiddleware(c.req.raw);
        // if (rateLimitError) return rateLimitErrorToResponse(rateLimitError);
    },
    afterHandle: (_c: Context, res: Response) => {
        if (!res.headers.has("Cache-Control")) {
            res.headers.set("Cache-Control", "no-cache, no-store, max-age=0, must-revalidate");
        }
        return res;
    },
};

const app = new Hono();

app.route("/auth", createAuthRoutes(handlers));

export default app;
