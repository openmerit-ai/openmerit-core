import assert from "node:assert/strict";
import { test } from "node:test";
import worker, { type InboundEmail } from "./worker.ts";

function message(to: string): InboundEmail & { forwarded: string[]; rejected: string[] } {
  const forwarded: string[] = [];
  const rejected: string[] = [];
  return {
    to, forwarded, rejected,
    forward: async (address) => { forwarded.push(address); },
    setReject: (reason) => { rejected.push(reason); },
  };
}

test("code@ reaches lazim and praveen, whatever the address case", async () => {
  const email = message("Code@OpenMerit.ai");
  await worker.email(email);
  assert.deepEqual(email.forwarded, ["code@lazim.one", "prvn431@gmail.com"]);
  assert.deepEqual(email.rejected, []);
});

test("an address without recipients is rejected, not forwarded", async () => {
  const email = message("lazim@openmerit.ai");
  await worker.email(email);
  assert.deepEqual(email.forwarded, []);
  assert.deepEqual(email.rejected, ["Unknown address"]);
});
