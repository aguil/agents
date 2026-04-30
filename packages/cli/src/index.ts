export function main(argv: readonly string[] = Bun.argv.slice(2)): number {
  if (argv.includes("--help") || argv.length === 0) {
    console.log("Usage: agents <command> [options]");
    return 0;
  }

  console.error(`Unknown command: ${argv[0]}`);
  return 1;
}

if (import.meta.main) {
  process.exitCode = main();
}
