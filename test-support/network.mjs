import { website } from "../lib/site.mjs";

export function mockNetwork(t, handler) {
  t.mock.method(globalThis, "fetch", handler);
  t.mock.method(website, "fetch", handler);
}
