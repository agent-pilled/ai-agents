import { main } from "./cli.ts";

// Run with: node tools/github-apps/register.ts --help
process.exitCode = await main(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
});
