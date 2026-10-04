// Presentation-only interactions. These pages never call authentication APIs.
const screens = new Set(['login', 'verify', 'dashboard']);
let activeScreen = 'dashboard';

function showScreen(screen, focus = false) {
  if (!screens.has(screen)) return;
  activeScreen = screen;
  document.querySelectorAll('[data-screen]').forEach(section => {
    section.hidden = section.dataset.screen !== screen;
  });
  if (focus) {
    const heading = document.querySelector(`[data-screen="${screen}"] h1`);
    if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus({preventScroll:true}); }
  }
  if (window.parent !== window) window.parent.postMessage({type: 'nearkey-proposal-navigation', screen}, window.location.origin);
}

window.addEventListener('message', event => {
  if (event.origin === window.location.origin && event.source === window.parent && event.data?.type === 'nearkey-proposal-screen') showScreen(event.data.screen);
});
document.addEventListener('click', event => {
  const link = event.target.closest('[data-go]');
  if (link) { event.preventDefault(); showScreen(link.dataset.go, true); }
  if (event.target.closest('[data-add-app]')) openAppDialog();
  if (event.target.closest('[data-connect-phone]')) openPhoneDialog();
});
document.addEventListener('submit', event => {
  if (!event.target.matches('[data-login]')) return;
  event.preventDefault();
  showScreen('verify', true);
});

const dialogStyles = document.createElement('style');
dialogStyles.textContent = `
  [data-screen][hidden]{display:none!important}
  .proposal-dialog{box-sizing:border-box;width:min(460px,calc(100% - 32px));padding:30px;border:1px solid color-mix(in srgb,var(--preview-ink) 25%,transparent);border-radius:18px;background:var(--preview-bg,#fcfcf9);color:var(--preview-ink,#202923);font:15px/1.5 'DM Sans',system-ui,sans-serif;box-shadow:0 24px 90px #0003}
  .proposal-dialog::backdrop{background:#10251a77;backdrop-filter:blur(4px)}
  .proposal-dialog h2{font-size:26px;margin:0 0 12px;letter-spacing:-.8px;color:inherit}
  .proposal-dialog p{color:inherit;opacity:.75;margin:0 0 20px}
  .proposal-dialog label{display:block;margin:15px 0 7px;font-size:13px;font-weight:600}
  .proposal-dialog input{box-sizing:border-box;width:100%;padding:12px;border:1px solid color-mix(in srgb,currentColor 40%,transparent);border-radius:8px;background:transparent;color:inherit;font:inherit}
  .proposal-dialog input::placeholder{color:inherit;opacity:.6}
  .proposal-dialog-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:24px}
  .proposal-dialog button{padding:10px 16px;border:1px solid color-mix(in srgb,currentColor 35%,transparent);border-radius:8px;background:transparent;color:inherit;cursor:pointer;font:inherit}
  .proposal-dialog button[type=submit]{background:var(--preview-primary,#243d30);color:var(--preview-primary-ink,white);border-color:var(--preview-primary,#243d30)}
  .proposal-added{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:20px;border-bottom:1px solid currentColor;list-style:none}
  .proposal-added small{display:block;opacity:.7}
`;
document.head.append(dialogStyles);

function createDialog(title, description) {
  const dialog = document.createElement('dialog');
  dialog.className = 'proposal-dialog';
  const base = getComputedStyle(document.body);
  dialog.style.setProperty('--preview-bg',base.backgroundColor);
  dialog.style.setProperty('--preview-ink',base.color);
  const primary = document.querySelector(`[data-screen="${activeScreen}"] .primary`);
  if (primary) {
    const colors = getComputedStyle(primary);
    dialog.style.setProperty('--preview-primary',colors.backgroundColor);
    dialog.style.setProperty('--preview-primary-ink',colors.color);
  }
  const heading = document.createElement('h2');
  heading.id = 'proposal-dialog-title';
  heading.textContent = title;
  dialog.setAttribute('aria-labelledby', heading.id);
  const copy = document.createElement('p');
  copy.textContent = description;
  dialog.append(heading, copy);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  return dialog;
}

function openAppDialog() {
  if (document.querySelector('dialog[open]')) return;
  const dialog = createDialog('Add an app', 'Save a name and optional website in this design preview.');
  const form = document.createElement('form');
  form.innerHTML = `<label for="preview-app-name">App name</label><input id="preview-app-name" name="name" required maxlength="80" placeholder="My workspace" autocomplete="off"><label for="preview-app-url">Website (optional)</label><input id="preview-app-url" name="url" type="url" placeholder="https://example.com"><div class="proposal-dialog-actions"><button type="button" data-close>Cancel</button><button type="submit">Save app</button></div>`;
  form.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  form.addEventListener('submit', event => {
    event.preventDefault();
    const name = form.elements.name.value.trim();
    if (!name) { form.elements.name.setCustomValidity('Enter an app name.'); form.elements.name.reportValidity(); return; }
    const list = document.querySelector('[data-screen="dashboard"] [data-app-list]');
    if (list) {
      const item = document.createElement(['UL', 'OL'].includes(list.tagName) ? 'li' : 'div');
      item.className = 'sample-app proposal-added';
      const text = document.createElement('div');
      const label = document.createElement('strong');
      label.textContent = name;
      const website = document.createElement('small');
      website.textContent = form.elements.url.value || 'Saved app';
      text.append(label, website);
      const status = document.createElement('span');
      status.textContent = 'Saved';
      item.append(text, status);
      list.append(item);
      document.querySelectorAll('[data-app-count]').forEach(label => { label.textContent = `${list.querySelectorAll('.sample-app').length} saved`; });
    }
    dialog.close();
  });
  form.elements.name.addEventListener('input', () => form.elements.name.setCustomValidity(''));
  dialog.append(form);
  dialog.showModal();
}

function openPhoneDialog() {
  if (document.querySelector('dialog[open]')) return;
  const description = activeScreen === 'dashboard'
    ? 'Your sample session is already verified. In the app, you can show a replacement setup code, then enroll and verify your new phone. This preview shows sample data.'
    : 'In the app, verify your current phone first, then scan a setup code with your new phone. This preview shows the layout with sample data.';
  const dialog = createDialog('Connect a different phone', description);
  const actions = document.createElement('div');
  actions.className = 'proposal-dialog-actions';
  const cancel = document.createElement('button');
  cancel.textContent = 'Close';
  cancel.addEventListener('click', () => dialog.close());
  const view = document.createElement('button');
  view.textContent = 'Preview phone setup';
  view.addEventListener('click', () => { dialog.close(); showScreen('verify', true); });
  actions.append(cancel, view);
  dialog.append(actions);
  dialog.showModal();
}

showScreen(new URLSearchParams(window.location.search).get('screen') || activeScreen);
