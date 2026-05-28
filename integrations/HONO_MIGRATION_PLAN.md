# SuperTokens + Hono Integration — Migration Plan

This document describes the integration file you will add to your app, how it works, and a step-by-step plan to migrate from Express or Next.js App Router auth routes to Hono.

It is based on the current design in `integrations/hono.ts`.

---

## Table of contents

1. [Goals and design principles](#1-goals-and-design-principles)
2. [What you are building](#2-what-you-are-building)
3. [How the integration works internally](#3-how-the-integration-works-internally)
4. [Where to put files in your app](#4-where-to-put-files-in-your-app)
5. [Prerequisites and dependencies](#5-prerequisites-and-dependencies)
6. [SuperTokens configuration changes](#6-supertokens-configuration-changes)
7. [Core usage (minimal setup)](#7-core-usage-minimal-setup)
8. [Migration from Express](#8-migration-from-express)
9. [Migration from Next.js App Router](#9-migration-from-nextjs-app-router)
10. [CORS setup](#10-cors-setup)
11. [Protected API routes](#11-protected-api-routes)
12. [Error handling](#12-error-handling)
13. [Optional helpers](#13-optional-helpers)
14. [API reference](#14-api-reference)
15. [Recommended app structure](#15-recommended-app-structure)
16. [Migration checklist](#16-migration-checklist)
17. [Testing plan](#17-testing-plan)
18. [Common pitfalls](#18-common-pitfalls)
19. [Rollback strategy](#19-rollback-strategy)

---

## 1. Goals and design principles

### What this integration is for

- Run SuperTokens auth endpoints (`/auth/signup`, `/auth/signin`, `/auth/signout`, `/auth/session/refresh`, etc.) on a **Hono** server.
- Keep auth routing **explicit**: you mount `/auth` yourself; nothing is hidden behind a global catch-all middleware.
- Mirror the mental model you already use with **Next.js App Router** (`getAppDirRequestHandler` + a dedicated auth route file).
- Support hooks (`beforeHandle`, `afterHandle`) for rate limiting, logging, and cache headers.

### What this integration is not

- It is **not** a built-in SuperTokens framework adapter (like `supertokens-node/framework/express`).
- It does **not** auto-register middleware on every request.
- It does **not** replace your SuperTokens backend config, recipes, or frontend SDK setup.

### Design principles

| Principle | Meaning |
|-----------|---------|
| Explicit mount | Auth only runs on routes you mount with `app.route("/auth", ...)` |
| Single entry | One function (`createAuthRoutes`) handles all HTTP methods |
| Composable hooks | Rate limits and headers plug in via `beforeHandle` / `afterHandle` |
| Separation | Auth routes and protected API routes are configured independently |

---

## 2. What you are building

You will copy **one integration file** into your app (suggested path below), then wire it in three places:

1. **SuperTokens init** — set `framework: "custom"`.
2. **Auth routes** — `app.route("/auth", createAuthRoutes(handlers))`.
3. **Protected routes** — `verifySession()` on individual API routes + `app.onError(errorHandler())`.

### End state (conceptual)

```
Client
  │
  ├─ POST /auth/signup      ──► createAuthRoutes() ──► SuperTokens
  ├─ POST /auth/signin      ──► createAuthRoutes() ──► SuperTokens
  ├─ POST /auth/signout     ──► createAuthRoutes() ──► SuperTokens
  ├─ POST /auth/session/refresh ──► createAuthRoutes() ──► SuperTokens
  │
  └─ GET  /sessioninfo      ──► verifySession() ──► your handler
```

Auth traffic and API traffic are clearly separated in your Hono app.

---

## 3. How the integration works internally

### Layer diagram

```
┌─────────────────────────────────────────────────────────┐
│  Your Hono app                                          │
│  app.route("/auth", createAuthRoutes(handlers))         │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│  integrations/hono.ts (your copy)                     │
│  • beforeHandle / afterHandle hooks                     │
│  • auth.all("/*", handler) — all HTTP methods           │
│  • passes c.req.raw (Web Request) downstream          │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│  supertokens-node/custom                                │
│  handleAuthAPIRequest()                                 │
│  • builds PreParsedRequest + CollectingResponse         │
│  • calls SuperTokens.middleware()                       │
│  • returns 404 if path is not a SuperTokens API         │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│  SuperTokens core + recipes (EmailPassword, Session…)   │
└─────────────────────────────────────────────────────────┘
```

### Request flow for `/auth/signin`

1. Request hits your main Hono app at `/auth/signin`.
2. Hono routes it to the sub-app returned by `createAuthRoutes`.
3. Sub-app matches `all("/*", ...)`.
4. `beforeHandle` runs (e.g. rate limit). If it returns a `Response`, SuperTokens is skipped.
5. `handleAuthAPIRequest()(c.req.raw)` runs SuperTokens logic.
6. SuperTokens writes cookies/headers/body into a `CollectingResponse`, converted to a Web `Response`.
7. `afterHandle` runs (e.g. set `Cache-Control`).
8. Response returned to client.

### Why `c.req.raw`?

Hono wraps the standard Web `Request` API. SuperTokens' custom framework helpers (`handleAuthAPIRequest`, `withSession`, etc.) expect a Web `Request`. `c.req.raw` is that object.

---

## 4. Where to put files in your app

Suggested layout for a monorepo like HealthConnect:

```
packages/
  auth/
    src/
      backendConfig.ts          # existing supertokens.init()
      hono/
        supertokens-hono.ts     # copy of integrations/hono.ts
        authHandlers.ts         # your beforeHandle / afterHandle (rate limit, cache)
        authRoutes.ts             # createAuthRoutes(handlers) export
  api/  (or apps/server/)
    src/
      index.ts                  # main Hono app — mounts /auth + API routes
```

You can also keep it flatter:

```
src/
  lib/
    supertokens-hono.ts
  routes/
    auth.ts
  index.ts
```

**Recommendation:** keep the generic integration in `supertokens-hono.ts` and app-specific hooks (rate limiting, logging) in a separate `authHandlers.ts`.

---

## 5. Prerequisites and dependencies

### npm packages

Your app already has `supertokens-node`. Add:

```bash
npm install hono cookie
```

| Package | Purpose |
|---------|---------|
| `hono` | Web framework |
| `cookie` | Serialize `Set-Cookie` headers (used internally by SuperTokens custom framework; already a dependency of `supertokens-node`) |

### Runtime

Works on:

- Node.js (with `@hono/node-server` or similar)
- Cloudflare Workers
- Vercel Edge
- Any runtime where Hono and `supertokens-node` run

### SuperTokens core

Your existing SuperTokens core connection (`connectionURI` or self-hosted core) stays the same. No core migration required.

---

## 6. SuperTokens configuration changes

### Required change: set `framework: "custom"`

In your existing `backendConfig.ts` / `ensureSuperTokensInit()`:

```ts
import supertokens from "supertokens-node";
import EmailPassword from "supertokens-node/recipe/emailpassword";
import Session from "supertokens-node/recipe/session";

export function ensureSuperTokensInit() {
  if (supertokens.isInited()) return;

  supertokens.init({
    framework: "custom", // ← required for this integration
    supertokens: {
      connectionURI: process.env.SUPERTOKENS_CONNECTION_URI!,
    },
    appInfo: {
      appName: "YourApp",
      apiDomain: process.env.API_DOMAIN!,
      websiteDomain: process.env.WEBSITE_DOMAIN!,
      apiBasePath: "/auth", // default; change only if your mount path differs
    },
    recipeList: [
      EmailPassword.init(),
      Session.init(),
      // ... your other recipes
    ],
  });
}
```

### Important: `apiBasePath` must match your mount path

If you mount with:

```ts
app.route("/auth", createAuthRoutes(handlers));
```

Then `appInfo.apiBasePath` should be `"/auth"` (this is the SuperTokens default).

If you mount at `/api/auth`:

```ts
app.route("/api/auth", createAuthRoutes(handlers));
```

Then set `apiBasePath: "/api/auth"`.

The frontend SuperTokens SDK must use the same base path.

---

## 7. Core usage (minimal setup)

### Step 1 — Copy the integration file

Copy `integrations/hono.ts` from this repo into your app as e.g. `src/lib/supertokens-hono.ts`.

### Step 2 — Create auth handlers (optional hooks)

```ts
// src/routes/authHandlers.ts
import type { Context } from "hono";
import type { AuthRouteHandlerOptions } from "../lib/supertokens-hono";

export const authHandlers: AuthRouteHandlerOptions = {
  beforeHandle: async (c: Context) => {
    // Optional: rate limiting, logging, etc.
    // Return a Response to block the request before SuperTokens runs.
  },

  afterHandle: async (_c: Context, res: Response) => {
    if (!res.headers.has("Cache-Control")) {
      res.headers.set(
        "Cache-Control",
        "no-cache, no-store, max-age=0, must-revalidate"
      );
    }
    return res;
  },
};
```

### Step 3 — Mount auth routes

```ts
// src/index.ts
import { Hono } from "hono";
import { cors } from "hono/cors";
import supertokens from "supertokens-node";
import { ensureSuperTokensInit } from "@healthconnect/auth/backendConfig";
import { createAuthRoutes, verifySession, errorHandler } from "./lib/supertokens-hono";
import { authHandlers } from "./routes/authHandlers";

ensureSuperTokensInit();

const app = new Hono();

app.use("*", cors({
  origin: process.env.WEBSITE_DOMAIN!,
  credentials: true,
  allowHeaders: ["Content-Type", ...supertokens.getAllCORSHeaders()],
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
}));

// All SuperTokens auth endpoints live here
app.route("/auth", createAuthRoutes(authHandlers));

// Protected routes — explicit, separate from auth
app.get("/sessioninfo", verifySession(), (c) =>
  c.json({
    userId: c.req.session!.getUserId(),
    sessionHandle: c.req.session!.getHandle(),
  })
);

app.onError(errorHandler());

export default app;
```

That is the complete minimal wiring.

---

## 8. Migration from Express

### Before (Express)

```ts
import { middleware, errorHandler } from "supertokens-node/framework/express";
import { verifySession } from "supertokens-node/recipe/session/framework/express";

app.use(middleware()); // catch-all — handles /auth/* on every request

app.get("/sessioninfo", verifySession(), (req, res) => {
  res.json({ userId: req.session!.getUserId() });
});

app.use(errorHandler());
```

### After (Hono)

```ts
import { createAuthRoutes, verifySession, errorHandler } from "./lib/supertokens-hono";

app.route("/auth", createAuthRoutes(authHandlers)); // explicit — only /auth/*

app.get("/sessioninfo", verifySession(), (c) =>
  c.json({ userId: c.req.session!.getUserId() })
);

app.onError(errorHandler());
```

### Mapping table

| Express | Hono integration |
|---------|------------------|
| `supertokens.init({ framework: "express" })` | `supertokens.init({ framework: "custom" })` |
| `app.use(middleware())` | `app.route("/auth", createAuthRoutes(handlers))` |
| `verifySession()` from `framework/express` | `verifySession()` from your hono integration file |
| `app.use(errorHandler())` | `app.onError(errorHandler())` |
| `req.session` | `c.req.session` |
| `SessionRequest` type | Hono module augmentation (`c.req.session`) |

### What to remove from Express app

- `import { middleware, errorHandler } from "supertokens-node/framework/express"`
- `import { verifySession } from "supertokens-node/recipe/session/framework/express"`
- `app.use(middleware())` global middleware
- `express` body parser concerns for SuperTokens routes (Hono parses body via `c.req.json()` / `c.req.parseBody()` internally)

---

## 9. Migration from Next.js App Router

This is closest to your current HealthConnect setup.

### Before (Next.js App Router)

```ts
// app/auth/[[...path]]/route.ts
import { getAppDirRequestHandler } from "supertokens-node/nextjs";

const handleCall = getAppDirRequestHandler();

export async function POST(request: NextRequest) {
  const rateLimitError = await rateLimitMiddleware(request);
  if (rateLimitError) return rateLimitErrorToResponse(rateLimitError);
  return handleCall(request);
}

// ... same for GET, DELETE, PUT, PATCH, HEAD
```

### After (Hono)

```ts
// src/routes/authHandlers.ts
import { createRateLimitMiddleware, rateLimitErrorToResponse } from "@healthconnect/lib/rateLimit";
import { ipAddress } from "@vercel/functions";
import type { AuthRouteHandlerOptions } from "../lib/supertokens-hono";

const rateLimitMiddleware = createRateLimitMiddleware({
  window: env.AUTH_RATE_LIMIT_WINDOW_SECONDS,
  max: env.AUTH_RATE_LIMIT_MAX_REQUESTS,
  getIpAddress: (request) => ipAddress(request) ?? null,
});

export const authHandlers: AuthRouteHandlerOptions = {
  beforeHandle: async (c) => {
    const rateLimitError = await rateLimitMiddleware(c.req.raw);
    if (rateLimitError) {
      // optional: logger.warn(...)
      return rateLimitErrorToResponse(rateLimitError);
    }
  },

  afterHandle: (_c, res) => {
    if (!res.headers.has("Cache-Control")) {
      res.headers.set(
        "Cache-Control",
        "no-cache, no-store, max-age=0, must-revalidate"
      );
    }
    return res;
  },
};
```

```ts
// src/index.ts
app.route("/auth", createAuthRoutes(authHandlers));
```

### Mapping table

| Next.js App Router | Hono integration |
|--------------------|------------------|
| `getAppDirRequestHandler()` | `getAuthRequestHandler()` (same underlying function) |
| `export async function POST(request)` × 6 | `createAuthRoutes(handlers)` (all methods automatically) |
| Rate limit in each method | `beforeHandle` once |
| Cache-Control after each method | `afterHandle` once |
| `NextRequest` | `c.req.raw` (inside hooks) or `c` (Hono context) |

### What to delete after migration

- Next.js auth catch-all route file (`app/auth/[[...path]]/route.ts` or similar)
- Per-method exports (`GET`, `POST`, `DELETE`, …) if fully replaced by Hono server
- `getAppDirRequestHandler` import from `supertokens-node/nextjs` (unless still used elsewhere)

---

## 10. CORS setup

SuperTokens requires specific CORS headers for session cookies and anti-CSRF tokens.

```ts
import { cors } from "hono/cors";
import supertokens from "supertokens-node";

app.use("*", cors({
  origin: process.env.WEBSITE_DOMAIN!,
  credentials: true,
  allowHeaders: [
    "Content-Type",
    ...supertokens.getAllCORSHeaders(),
  ],
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
}));
```

Apply CORS on the **main app**, before mounting auth routes. This covers both `/auth/*` and your protected API routes.

---

## 11. Protected API routes

Auth routes and protected routes are configured separately.

### Require session (recommended)

```ts
app.get("/sessioninfo", verifySession(), (c) =>
  c.json({ userId: c.req.session!.getUserId() })
);

app.post("/api/data", verifySession(), async (c) => {
  const body = await c.req.json();
  // c.req.session is guaranteed when verifySession() passes
  return c.json({ ok: true });
});
```

### Optional session (manual check)

If you don't use `verifySession()`, check manually:

```ts
app.get("/maybe-auth", async (c) => {
  // use withSession helper — see section 13
});
```

### `verifySession` options

Same options as the Express/Session recipe API:

```ts
verifySession({
  sessionRequired: true,
  overrideGlobalClaimValidators: async () => [],
})
```

---

## 12. Error handling

### Global error handler

Register once on your main app:

```ts
app.onError(errorHandler());
```

This handles SuperTokens session errors (e.g. expired session, invalid claims) on **protected routes** that use `verifySession()`.

### Auth route errors

Auth endpoint errors (wrong password, email already exists, etc.) are handled **inside** `handleAuthAPIRequest` and returned as normal JSON responses. You do not need extra error handling for `/auth/*`.

### Order matters

```ts
app.route("/auth", createAuthRoutes(authHandlers));
app.get("/sessioninfo", verifySession(), handler);
// ... other routes
app.onError(errorHandler()); // last
```

---

## 13. Optional helpers

These are exported for advanced use cases. Most apps only need `createAuthRoutes`, `verifySession`, and `errorHandler`.

| Function | When to use |
|----------|-------------|
| `getAuthRequestHandler()` | Low-level access; returns `(request: Request) => Promise<Response>` |
| `handleAuthRequest(c)` | Single explicit handler if not using `createAuthRoutes` |
| `withSession(c, handler, options?)` | Server-side route that optionally needs session without middleware |
| `withPreParsedRequestResponse(c, handler)` | Custom logic with SuperTokens request/response objects |
| `wrapHonoRequest(c)` / `wrapHonoResponse()` | Manual adapter usage |

### Example: SSR-style session read

```ts
import { withSession } from "./lib/supertokens-hono";

app.get("/profile", async (c) => {
  return withSession(c, async (error, session) => {
    if (error || !session) {
      return c.json({ message: "Unauthorized" }, 401);
    }
    return c.json({ userId: session.getUserId() });
  });
});
```

---

## 14. API reference

### `createAuthRoutes(handlers?)`

Returns a `Hono` sub-app. Mount with `app.route("/auth", createAuthRoutes(handlers))`.

**Parameters:**

```ts
type AuthRouteHandlerOptions = {
  beforeHandle?: (c: Context) => Promise<Response | undefined | void>;
  afterHandle?: (c: Context, response: Response) => Response | Promise<Response>;
};
```

**Handles:** all HTTP methods on all sub-paths (`/*`).

**SuperTokens endpoints handled** (when recipes are configured):

- `/auth/signup`, `/auth/signin`, `/auth/signout`
- `/auth/session/refresh`
- Other recipe APIs under your `apiBasePath`
- Returns `404` for unknown paths under `/auth`

---

### `verifySession(options?)`

Returns Hono middleware. Use on individual protected routes.

- Sets `c.req.session` on success.
- Returns 401/403 response automatically when SuperTokens error handler fills the response.

---

### `errorHandler()`

Returns Hono `ErrorHandler` for `app.onError()`.

---

### `getAuthRequestHandler()`

Returns the same handler as Next.js `getAppDirRequestHandler()`.

---

### Type augmentation

The integration extends Hono's types:

```ts
c.req.session // SessionContainer | undefined
```

Ensure your `tsconfig.json` includes the file so module augmentation is picked up.

---

## 15. Recommended app structure

Full example for HealthConnect-style setup:

```
src/
  lib/
    supertokens-hono.ts       # generic integration (copy from repo)
  routes/
    authHandlers.ts           # rate limit + cache headers
  index.ts                    # main Hono app
```

**`authHandlers.ts`**

```ts
import type { AuthRouteHandlerOptions } from "../lib/supertokens-hono";
import { createRateLimitMiddleware, rateLimitErrorToResponse } from "@healthconnect/lib/rateLimit";
import { logger } from "@healthconnect/lib/logger";
import { ipAddress } from "@vercel/functions";
import { env } from "@/env";

const rateLimitMiddleware = createRateLimitMiddleware({
  window: env.AUTH_RATE_LIMIT_WINDOW_SECONDS,
  max: env.AUTH_RATE_LIMIT_MAX_REQUESTS,
  getIpAddress: (request) => ipAddress(request) ?? null,
});

export const authHandlers: AuthRouteHandlerOptions = {
  beforeHandle: async (c) => {
    const rateLimitError = await rateLimitMiddleware(c.req.raw);
    if (rateLimitError) {
      logger.warn("Rate limit exceeded on auth route", {
        method: c.req.method,
        ip: ipAddress(c.req.raw),
        path: c.req.path,
      });
      return rateLimitErrorToResponse(rateLimitError);
    }
  },

  afterHandle: (_c, res) => {
    if (!res.headers.has("Cache-Control")) {
      res.headers.set(
        "Cache-Control",
        "no-cache, no-store, max-age=0, must-revalidate"
      );
    }
    return res;
  },
};
```

**`index.ts`**

```ts
import { Hono } from "hono";
import { cors } from "hono/cors";
import supertokens from "supertokens-node";
import { ensureSuperTokensInit } from "@healthconnect/auth/backendConfig";
import { createAuthRoutes, verifySession, errorHandler } from "./lib/supertokens-hono";
import { authHandlers } from "./routes/authHandlers";

ensureSuperTokensInit();

const app = new Hono();

app.use("*", cors({ /* ... */ }));

app.route("/auth", createAuthRoutes(authHandlers));

app.get("/sessioninfo", verifySession(), (c) =>
  c.json({ userId: c.req.session!.getUserId() })
);

app.onError(errorHandler());

export default app;
```

---

## 16. Migration checklist

Use this as a step-by-step runbook.

### Phase 1 — Prepare

- [ ] Copy `integrations/hono.ts` into your app
- [ ] Install `hono` (and server adapter if needed, e.g. `@hono/node-server`)
- [ ] Update `supertokens.init({ framework: "custom" })`
- [ ] Confirm `appInfo.apiBasePath` matches mount path (`"/auth"`)
- [ ] Confirm frontend SDK `apiBasePath` matches

### Phase 2 — Wire Hono auth

- [ ] Create `authHandlers.ts` with your rate limit + cache logic
- [ ] Mount `app.route("/auth", createAuthRoutes(authHandlers))`
- [ ] Add CORS middleware with `supertokens.getAllCORSHeaders()`
- [ ] Add `app.onError(errorHandler())`

### Phase 3 — Migrate protected routes

- [ ] Replace Express `verifySession()` imports with your hono integration
- [ ] Replace `req.session` with `c.req.session`
- [ ] Move each protected route to explicit Hono handlers

### Phase 4 — Remove old stack

- [ ] Remove Express SuperTokens middleware (`framework/express`)
- [ ] Remove Next.js auth route file (if migrating from App Router)
- [ ] Remove unused `getAppDirRequestHandler` imports
- [ ] Remove Express-specific session types (`SessionRequest`)

### Phase 5 — Verify

- [ ] Run through [testing plan](#17-testing-plan)
- [ ] Deploy to staging
- [ ] Confirm frontend auth still works end-to-end

---

## 17. Testing plan

### Auth endpoints

| Test | Method | Path | Expected |
|------|--------|------|----------|
| Sign up | POST | `/auth/signup` | 200, `{ status: "OK" }`, session cookies set |
| Sign in | POST | `/auth/signin` | 200, `{ status: "OK" }`, session cookies set |
| Sign out | POST | `/auth/signout` | 200, cookies cleared |
| Session refresh | POST | `/auth/session/refresh` | 200 when valid refresh token present |
| Unknown auth path | GET | `/auth/does-not-exist` | 404 |

### Protected routes

| Test | Expected |
|------|----------|
| `/sessioninfo` without session | 401 |
| `/sessioninfo` with valid session | 200 + user data |

### Rate limiting (if configured)

| Test | Expected |
|------|----------|
| Exceed rate limit on `/auth/signin` | Rate limit response from `beforeHandle`, SuperTokens not called |

### CORS

| Test | Expected |
|------|----------|
| Preflight from frontend origin | Correct `Access-Control-Allow-*` headers |
| Credentials request | Cookies sent and received |

### Regression

- [ ] Existing users can sign in
- [ ] New users can sign up
- [ ] Session persists across page reload
- [ ] Token refresh works after access token expiry
- [ ] Frontend SDK recipe calls succeed without path changes

---

## 18. Common pitfalls

### 1. Forgetting `framework: "custom"`

SuperTokens init must use `"custom"`, not `"express"`.

### 2. `apiBasePath` mismatch

If you mount at `/auth` but `apiBasePath` is `/api/auth`, sign-in requests will 404.

### 3. CORS missing SuperTokens headers

Always spread `supertokens.getAllCORSHeaders()` into `allowHeaders`.

### 4. Rate limiter expects Express/Next request shape

Your rate limiter should accept Web `Request`. In hooks, pass `c.req.raw`:

```ts
beforeHandle: async (c) => {
  const err = await rateLimitMiddleware(c.req.raw);
}
```

### 5. Mount path vs recipe paths

`createAuthRoutes` only handles requests routed to it. If you mount at `/auth`, requests to `/api/auth/signin` will **not** hit SuperTokens unless you also mount there.

### 6. Body read twice

SuperTokens reads the body during auth handling. Do not call `c.req.json()` in `beforeHandle` unless you clone the request first.

### 7. Missing `errorHandler` on protected routes

Without `app.onError(errorHandler())`, unhandled session errors on protected routes may become generic 500s.

---

## 19. Rollback strategy

If you need to revert during migration:

1. Keep the old Express or Next.js auth route deployed in parallel on a different path or branch.
2. Switch frontend `apiBasePath` only after Hono auth is verified in staging.
3. The integration file is self-contained — removing it and restoring `framework: "express"` + Express middleware is sufficient to roll back the backend.

---

## Quick reference card

```ts
// 1. Init
supertokens.init({ framework: "custom", appInfo: { apiBasePath: "/auth", ... } });

// 2. Auth (all methods, all sub-paths)
app.route("/auth", createAuthRoutes({
  beforeHandle: async (c) => { /* rate limit; return Response to block */ },
  afterHandle: (_c, res) => res,
}));

// 3. Protected routes
app.get("/api/foo", verifySession(), (c) => c.json({ userId: c.req.session!.getUserId() }));

// 4. Errors
app.onError(errorHandler());
```

---

## Files in this repo

| File | Purpose |
|------|---------|
| `integrations/hono.ts` | Integration file to copy into your app |
| `integrations/hono-auth-routes.example.ts` | Minimal usage example |
| `integrations/HONO_MIGRATION_PLAN.md` | This document |

---

*Review this plan before starting migration. Adjust paths (`@healthconnect/...`) to match your monorepo layout.*
