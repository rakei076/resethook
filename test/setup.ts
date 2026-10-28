import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Env } from "../src/types";

const e = env as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };
await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);
