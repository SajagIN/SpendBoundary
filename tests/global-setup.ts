import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";

const TEST_DB = path.join(process.cwd(), "prisma", "test.db");

/** Builds a clean SQLite file for the integration suite before any test runs. */
export async function setup() {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);

  // execSync goes through a shell, which is what Windows needs to launch the
  // npx shim (execFileSync on npx.cmd fails with EINVAL there).
  execSync("npx prisma db push --skip-generate --accept-data-loss", {
    stdio: "ignore",
    env: { ...process.env, DATABASE_URL: "file:./test.db" },
  });
}

export async function teardown() {
  if (existsSync(TEST_DB)) rmSync(TEST_DB, { force: true });
}
