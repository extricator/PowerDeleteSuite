"use strict";
// Tests must never contact Reddit, GitHub, or any other live service.
function prohibited() { throw new Error("Live network is prohibited in tests; inject a mocked transport"); }
globalThis.fetch = prohibited;
for (const moduleName of ["node:http", "node:https"]) {
  const transport = require(moduleName);
  transport.request = prohibited;
  transport.get = prohibited;
}
