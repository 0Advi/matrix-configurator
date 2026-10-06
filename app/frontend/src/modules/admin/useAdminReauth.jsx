// The platform-admin token lasts 30 minutes. Every call made through `withAuth(fn)` runs
// fn(currentKey); on a 401 it asks the admin to sign in again (ReauthDialog), then retries ONCE
// with the fresh token — nothing the admin was doing is lost. Concurrent 401s share one dialog.
//
// F4b built this inside the Workspaces area only; the Requests and Password-resets tabs logged
// out on a 401 instead (F4b caveat 6). F5a: one hook, used by the whole portal (AdminPortalPage)
// and by WorkspacesArea, so every tab re-authenticates the same way.
import React from 'react';
import { adminLogin } from './adminApi.js';
import { ReauthDialog } from './workspaces/dialogs.jsx';

export function useAdminReauth({ keyValue, onKeyChange, onLogout }) {
  const keyRef = React.useRef(keyValue);
  keyRef.current = keyValue;
  const [reauth, setReauth] = React.useState(null); // {busy, error}
  const waiters = React.useRef([]);

  const askReauth = React.useCallback(() => new Promise((resolve, reject) => {
    waiters.current.push({ resolve, reject });
    setReauth((r) => r || { busy: false, error: null });
  }), []);

  const withAuth = React.useCallback(async (fn) => {
    try {
      return await fn(keyRef.current);
    } catch (e) {
      if (e?.status !== 401) throw e;
      const k = await askReauth();
      return fn(k);
    }
  }, [askReauth]);

  const submit = async (email, password) => {
    setReauth({ busy: true, error: null });
    try {
      const token = await adminLogin(email, password);
      keyRef.current = token;
      onKeyChange?.(token);
      setReauth(null);
      waiters.current.splice(0).forEach((w) => w.resolve(token));
    } catch (e) {
      setReauth({ busy: false, error: e.message || 'Sign-in failed.' });
    }
  };
  const cancel = () => {
    setReauth(null);
    waiters.current.splice(0).forEach((w) => w.reject(
      Object.assign(new Error('Sign-in cancelled — nothing was sent to the app.'), { cancelled: true })));
  };

  const dialog = reauth
    ? <ReauthDialog busy={reauth.busy} error={reauth.error} onSubmit={submit} onCancel={cancel}
        onSignOut={() => { cancel(); onLogout?.(); }}/>
    : null;
  return { withAuth, keyRef, dialog };
}
