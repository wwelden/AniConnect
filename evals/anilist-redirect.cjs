/**
 * Preloaded into another AniList MCP server (`node --require`, via NODE_OPTIONS) so its
 * requests to AniList go to the fake at FAKE_ANILIST_URL instead. Covers the global
 * fetch and the node-fetch package, which between them are how the servers we compare
 * against reach AniList.
 */
const ANILIST = "https://graphql.anilist.co";
const target = process.env.FAKE_ANILIST_URL;
if (!target) throw new Error("FAKE_ANILIST_URL is not set");

const rewrite = (url) => (url.startsWith(ANILIST) ? target + url.slice(ANILIST.length) : url);

const globalFetch = globalThis.fetch;
if (globalFetch) {
  globalThis.fetch = (input, init) => {
    if (typeof input === "string" || input instanceof URL) return globalFetch(rewrite(String(input)), init);
    if (input instanceof Request && input.url.startsWith(ANILIST)) return globalFetch(new Request(rewrite(input.url), input), init);
    return globalFetch(input, init);
  };
}

const Module = require("node:module");
const load = Module._load;
const wrapped = new WeakMap();
Module._load = function (request, ...rest) {
  const loaded = load.call(this, request, ...rest);
  if (request !== "node-fetch" || typeof loaded !== "function") return loaded;
  if (!wrapped.has(loaded)) {
    const fetch = (url, init) => loaded(typeof url === "string" || url instanceof URL ? rewrite(String(url)) : url, init);
    Object.assign(fetch, loaded, { default: fetch });
    wrapped.set(loaded, fetch);
  }
  return wrapped.get(loaded);
};
