import { createApp } from "./app.js";
import type { AppEnv } from "./app.js";
import { googleAllowlistAuth, openAuthOptions } from "./auth.js";
import type { AuthEnv } from "./auth.js";
import { basicLimits } from "./basic-limits.js";
import type { BasicLimitsEnv } from "./basic-limits.js";
import { envKeys } from "./command-provider.js";
import type { EnvKeysEnv } from "./command-provider.js";
import { noUsage } from "./seams.js";

export { Workspace } from "./workspace.js";

export default createApp<AppEnv & AuthEnv & BasicLimitsEnv & EnvKeysEnv>(
  (env, context) => ({
    auth: googleAllowlistAuth(env),
    limits: basicLimits(env, context),
    usage: noUsage,
    keys: envKeys(env),
  }),
  openAuthOptions,
);
