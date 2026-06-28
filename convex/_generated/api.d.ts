/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 *
 * NOTE: `convex codegen` wrote an untyped `AnyApi` fallback here because no live
 * Convex backend was reachable in this environment. This file is the standard
 * *typed* form `convex dev` produces from the local `convex/*.ts` modules, so
 * `api.loginAttempts.*` is fully type-checked. It is regenerated (and any new
 * domain modules added) the moment a deployment is configured.
 * @module
 */

import type * as dataPublish from "../dataPublish.js";
import type * as dataRows from "../dataRows.js";
import type * as dataTables from "../dataTables.js";
import type * as loginAttempts from "../loginAttempts.js";
import type * as roles from "../roles.js";
import type * as sessions from "../sessions.js";
import type * as setup from "../setup.js";
import type * as userPreferences from "../userPreferences.js";
import type * as users from "../users.js";
import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

/**
 * A utility for referencing Convex functions in your app's API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
declare const fullApi: ApiFromModules<{
  dataPublish: typeof dataPublish;
  dataRows: typeof dataRows;
  dataTables: typeof dataTables;
  loginAttempts: typeof loginAttempts;
  roles: typeof roles;
  sessions: typeof sessions;
  setup: typeof setup;
  userPreferences: typeof userPreferences;
  users: typeof users;
}>;
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;
