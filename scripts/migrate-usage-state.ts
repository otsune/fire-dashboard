import { migrateUsageFile } from "../services/usage/src/migrate";
const args = process.argv.slice(2);
const options: Record<string, string> = {};
try {
  if (args.length % 2) throw Error("arguments");
  for (let i = 0; i < args.length; i += 2) {
    if (!["--from", "--to", "--restore-legacy"].includes(args[i]) || options[args[i]] || !args[i + 1]) throw Error("arguments");
    options[args[i]] = args[i + 1];
  }
  if (!options["--from"] || !options["--to"]) throw Error("arguments");
  await migrateUsageFile({ from: options["--from"], to: options["--to"], restoreLegacy: options["--restore-legacy"] });
  process.stdout.write("Usage state converted; input files unchanged. Start only one publisher per topic.\n");
} catch {
  process.stderr.write("Usage migration failed. Stop writers first; use --from <file> --to <new-file> [--restore-legacy <legacy-file>]. Check input validity and ensure the destination does not exist.\n");
  process.exitCode = 1;
}
