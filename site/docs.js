const search = document.querySelector('.docs-search');
const form = search.querySelector('form');
const input = search.querySelector('input');
const panel = search.querySelector('.search-panel');
const status = search.querySelector('.search-status');
const results = search.querySelector('#search-results');
const clear = search.querySelector('.search-clear');
let searchPromise;
let queryRevision = 0;
let timer;
search.hidden = false;
input.setAttribute('aria-keyshortcuts', 'Meta+K Control+K');
search.querySelector('kbd').textContent = navigator.platform.startsWith('Mac') ? '⌘ K' : 'Ctrl K';

function closeSearch() {
  queryRevision++;
  clearTimeout(timer);
  panel.hidden = true;
  search.removeAttribute('aria-busy');
}

function loadSearch() {
  if (!searchPromise) {
    searchPromise = Promise.all([
      import(search.dataset.libraryUrl),
      fetch(search.dataset.indexUrl).then(response => {
        if (!response.ok) throw new Error('Search index unavailable');
        return response.json();
      }),
    ]).then(([{ default: MiniSearch }, bundle]) => MiniSearch.loadJSON(JSON.stringify(bundle.index), bundle.options))
      .catch(error => { searchPromise = undefined; throw error; });
  }
  return searchPromise;
}

async function runSearch() {
  const query = input.value.trim();
  const revision = ++queryRevision;
  clear.hidden = !query;
  if (query.length < 2) {
    results.replaceChildren();
    status.textContent = query ? 'Type at least two characters to search.' : '';
    panel.hidden = !query;
    return;
  }
  panel.hidden = false;
  search.setAttribute('aria-busy', 'true');
  results.replaceChildren();
  status.textContent = 'Searching…';
  try {
    const index = await loadSearch();
    if (revision !== queryRevision) return;
    const matches = index.search(query).slice(0, 8);
    results.replaceChildren();
    status.textContent = matches.length ? `${matches.length} results · Use ↓ to browse` : `No results for “${query}”. Try a command or topic, such as budget or setup.`;
    for (const match of matches) {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = match.url;
      for (const [className, text] of [
        ['search-result-meta', `${match.group} / ${match.pageTitle}`],
        ['search-result-title', match.title],
        ['search-result-excerpt', match.excerpt],
      ]) {
        const span = document.createElement('span');
        span.className = className;
        span.textContent = text;
        link.append(span);
      }
      item.append(link);
      results.append(item);
    }
  } catch {
    if (revision !== queryRevision) return;
    results.replaceChildren();
    status.textContent = 'Search couldn’t load. Try typing again, or browse the documentation navigation.';
  } finally {
    if (revision === queryRevision) search.removeAttribute('aria-busy');
  }
}

input.addEventListener('input', () => {
  closeSearch();
  clear.hidden = !input.value;
  timer = setTimeout(runSearch, 120);
});
input.addEventListener('focus', () => { if (input.value.trim()) runSearch(); });
clear.addEventListener('click', () => {
  input.value = '';
  clear.hidden = true;
  closeSearch();
  input.focus();
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  clearTimeout(timer);
  await runSearch();
  results.querySelector('a')?.focus();
});
search.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    // Focus first: the focus handler may request results; closeSearch invalidates it.
    input.focus();
    closeSearch();
    return;
  }
  if (!['ArrowDown', 'ArrowUp'].includes(event.key) || panel.hidden) return;
  const links = [...results.querySelectorAll('a')];
  if (!links.length) return;
  event.preventDefault();
  const index = links.indexOf(document.activeElement);
  if (event.key === 'ArrowDown') links[Math.min(index + 1, links.length - 1)].focus();
  else if (index <= 0) input.focus();
  else links[index - 1].focus();
});
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    input.focus();
    input.select();
  }
  if (event.key === 'Escape') {
    for (const details of document.querySelectorAll('.docs-mobile-nav[open], .docs-mobile-toc[open]')) {
      if (details.contains(document.activeElement)) details.querySelector('summary').focus();
      details.open = false;
    }
  }
});
document.addEventListener('pointerdown', event => { if (!search.contains(event.target)) closeSearch(); });
document.addEventListener('focusin', event => {
  // Wait for a new focus target; focusout can precede a result link receiving focus.
  if (!search.contains(event.target)) closeSearch();
});

const copyStatus = document.querySelector('#copy-status');
for (const block of document.querySelectorAll('.code-block')) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'code-copy';
  button.textContent = 'Copy';
  button.setAttribute('aria-label', 'Copy code example');
  let reset;
  button.addEventListener('click', async () => {
    clearTimeout(reset);
    const code = block.querySelector('code');
    try {
      await navigator.clipboard.writeText(code.textContent);
      button.textContent = 'Copied';
      copyStatus.textContent = 'Code copied to clipboard.';
    } catch {
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      block.querySelector('pre').focus();
      button.textContent = 'Selected';
      copyStatus.textContent = 'Clipboard unavailable. Code selected for manual copying.';
    }
    reset = setTimeout(() => { button.textContent = 'Copy'; copyStatus.textContent = ''; }, 2500);
  });
  block.append(button);
}

// Keep the article outline in sync without intercepting native anchor navigation.
const headings = [...document.querySelectorAll('.doc-prose h2, .doc-prose h3')];
const outlineLinks = [...document.querySelectorAll('.docs-toc nav a')];
let scheduled = false;
function updateOutline() {
  scheduled = false;
  const current = headings.filter(heading => heading.getBoundingClientRect().top <= 155).at(-1) ?? headings[0];
  for (const link of outlineLinks) {
    if (link.hash === `#${current?.id}`) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}
window.addEventListener('scroll', () => {
  if (!scheduled) { scheduled = true; requestAnimationFrame(updateOutline); }
}, { passive: true });
updateOutline();
