// Entry point. Boot order matters: the v5 constructor reads localStorage synchronously, so the
// storage bridge must finish hydrating it from the server BEFORE the dc runtime mounts the app.
import { startBridge } from './storage-bridge.js';
import { bootConfigurator } from './boot.js';

const loading = document.getElementById('cfg-loading');
try {
  await startBridge();
  await bootConfigurator();
  if (loading) {
    loading.classList.add('gone');
    setTimeout(() => loading.remove(), 300);
  }
} catch (err) {
  console.error('[cfg] boot failed', err);
  if (loading) {
    loading.classList.add('err');
    loading.textContent = 'The configurator failed to start.\n\n' + (err && err.message || err) + '\n\nSee the browser console for details.';
  }
}
