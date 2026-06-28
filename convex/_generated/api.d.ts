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

import type * as loginAttempts from "../loginAttempts.js";
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
  loginAttempts: typeof loginAttempts;
}>;
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;
