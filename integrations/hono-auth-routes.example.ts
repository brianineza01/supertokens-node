/**
 * Example: explicit auth route file for Hono.
 * Mirrors a Next.js App Router auth route that exports GET/POST/DELETE/...
 *
 * Mount with: app.route("/auth", authRoutes)
 */

import { Hono } from "hono";
import { createAuthRouteHandlers } from "./hono";

// ensureSuperTokensInit();

const authRoutes = new Hono();

const handlers = createAuthRouteHandlers({
    beforeHandle: async (_c) => {
        // const rateLimitError = await rateLimitMiddleware(c.req.raw);
        // if (rateLimitError) return rateLimitErrorToResponse(rateLimitError);
    },
    afterHandle: (_c, res) => {
        if (!res.headers.has("Cache-Control")) {
            res.headers.set("Cache-Control", "no-cache, no-store, max-age=0, must-revalidate");
        }
        return res;
    },
});

// You choose which methods and paths receive SuperTokens auth handling.
authRoutes.get("/*", handlers.GET);
authRoutes.post("/*", handlers.POST);
authRoutes.delete("/*", handlers.DELETE);
authRoutes.put("/*", handlers.PUT);
authRoutes.patch("/*", handlers.PATCH);
authRoutes.head("/*", handlers.HEAD);

export default authRoutes;
