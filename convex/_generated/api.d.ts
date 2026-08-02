/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as aiConversations from "../aiConversations.js";
import type * as aiCredentials from "../aiCredentials.js";
import type * as aiDefaults from "../aiDefaults.js";
import type * as aiPricing from "../aiPricing.js";
import type * as aiUsage from "../aiUsage.js";
import type * as audit from "../audit.js";
import type * as dataPublish from "../dataPublish.js";
import type * as dataRows from "../dataRows.js";
import type * as dataTables from "../dataTables.js";
import type * as importExport from "../importExport.js";
import type * as loginAttempts from "../loginAttempts.js";
import type * as loops from "../loops.js";
import type * as media from "../media.js";
import type * as mediaFolders from "../mediaFolders.js";
import type * as mediaStorage from "../mediaStorage.js";
import type * as pluginSchedules from "../pluginSchedules.js";
import type * as pluginSecrets from "../pluginSecrets.js";
import type * as plugins from "../plugins.js";
import type * as roles from "../roles.js";
import type * as sessions from "../sessions.js";
import type * as setup from "../setup.js";
import type * as setupTx from "../setupTx.js";
import type * as site from "../site.js";
import type * as userPreferences from "../userPreferences.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  aiConversations: typeof aiConversations;
  aiCredentials: typeof aiCredentials;
  aiDefaults: typeof aiDefaults;
  aiPricing: typeof aiPricing;
  aiUsage: typeof aiUsage;
  audit: typeof audit;
  dataPublish: typeof dataPublish;
  dataRows: typeof dataRows;
  dataTables: typeof dataTables;
  importExport: typeof importExport;
  loginAttempts: typeof loginAttempts;
  loops: typeof loops;
  media: typeof media;
  mediaFolders: typeof mediaFolders;
  mediaStorage: typeof mediaStorage;
  pluginSchedules: typeof pluginSchedules;
  pluginSecrets: typeof pluginSecrets;
  plugins: typeof plugins;
  roles: typeof roles;
  sessions: typeof sessions;
  setup: typeof setup;
  setupTx: typeof setupTx;
  site: typeof site;
  userPreferences: typeof userPreferences;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
