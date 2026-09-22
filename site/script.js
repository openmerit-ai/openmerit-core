document.documentElement.classList.add('js');

const menuButton = document.querySelector('.menu-toggle');
const navigation = document.querySelector('#primary-nav');
menuButton.hidden = false;

function closeMenu() {
  menuButton.setAttribute('aria-expanded', 'false');
  navigation.classList.remove('is-open');
}

menuButton.addEventListener('click', () => {
  const open = menuButton.getAttribute('aria-expanded') !== 'true';
  menuButton.setAttribute('aria-expanded', String(open));
  navigation.classList.toggle('is-open', open);
});
navigation.addEventListener('click', (event) => {
  if (event.target.closest('a')) closeMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && menuButton.getAttribute('aria-expanded') === 'true') {
    closeMenu();
    menuButton.focus();
  }
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('.site-header')) closeMenu();
});
window.matchMedia('(max-width: 580px)').addEventListener('change', closeMenu);

const copyButton = document.querySelector('[data-copy]');
copyButton.hidden = false;
let copyReset;
copyButton.addEventListener('click', async () => {
  const code = document.querySelector('#install-code');
  const status = document.querySelector('#copy-status');
  const label = copyButton.querySelector('span');
  clearTimeout(copyReset);
  try {
    await navigator.clipboard.writeText(code.textContent.trim());
    label.textContent = 'Copied';
    status.textContent = 'Installation command copied to clipboard.';
  } catch {
    const range = document.createRange();
    range.selectNodeContents(code);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    code.parentElement.focus();
    label.textContent = 'Select & copy';
    status.textContent = 'Clipboard access is unavailable. Command selected; press Command+C or Control+C to copy.';
  }
  copyReset = setTimeout(() => { label.textContent = 'Copy command'; status.textContent = ''; }, 3500);
});
