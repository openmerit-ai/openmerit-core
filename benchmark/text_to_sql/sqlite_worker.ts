#!/usr/bin/env node
/** Isolated SQLite execution process so model-generated queries can time out. */

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

interface WorkerInput {
  schema: string;
  seed: string;
  sql: string;
  rowLimit: number;
}

function main(): void {
  const input = JSON.parse(readFileSync(0, "utf8")) as WorkerInput;
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(input.schema);
    database.exec(input.seed);
    database.exec("PRAGMA query_only = ON");
    const statement = database.prepare(input.sql);
    const columns = statement.columns().map((column) => column.name);
    statement.setReturnArrays(true);
    const rows: unknown[][] = [];
    for (const row of statement.iterate() as Iterable<unknown[]>) {
      rows.push(row);
      if (rows.length > input.rowLimit) {
        throw new Error(`Query result exceeds the ${input.rowLimit}-row safety limit`);
      }
    }
    process.stdout.write(JSON.stringify({ columns, rows }));
  } finally {
    database.close();
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
