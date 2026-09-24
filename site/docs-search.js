async function loadBundle({ libraryUrl, indexUrl }, { fetch, importModule }) {
  const [{ default: MiniSearch }, response] = await Promise.all([
    importModule(libraryUrl),
    fetch(indexUrl),
  ]);
  if (!response.ok) throw new Error('Search index unavailable');
  const bundle = await response.json();
  return MiniSearch.loadJSON(JSON.stringify(bundle.index), bundle.options);
}

export async function loadSearchIndex(urls, dependencies = {}) {
  const loaders = {
    fetch: globalThis.fetch.bind(globalThis),
    importModule: url => import(url),
    ...dependencies,
  };
  try {
    return await loadBundle(urls, loaders);
  } catch {
    // A page left open during deployment can reference files that were replaced.
    const response = await loaders.fetch('/docs/manifest.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('Search manifest unavailable');
    const { searchIndex, searchLibrary } = await response.json();
    if (!/^\/docs\/search-index\.[a-f0-9]+\.json$/.test(searchIndex)
      || !/^\/docs\/minisearch\.[a-f0-9]+\.js$/.test(searchLibrary)) {
      throw new Error('Invalid search manifest');
    }
    // Browsers can cache failed module imports. Recovery needs a fresh module URL.
    return loadBundle({ indexUrl: searchIndex, libraryUrl: `${searchLibrary}?recovery=${Date.now()}` }, loaders);
  }
}
