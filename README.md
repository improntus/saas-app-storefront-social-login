# Improntus Social Login Block

## Summary

The Improntus Social Login block renders Facebook and Google sign-in buttons inside the authentication modal flow. It opens a popup to an Adobe I/O Runtime endpoint, listens for the response, writes customer session cookies, emits `authenticated`, and then reloads or redirects based on configuration.

---

## NPM Package: `@improntus/saas-app-storefront-social-login`

The code in this directory is published as an npm package (same approach as `@improntus/saas-app-storefront-mercadopago`). When installed in the root of an EDS storefront using Adobe Commerce Drop-ins, `postinstall` **copies** block assets and **can patch** host files when they match known patterns. Changes are **idempotent** (already-applied edits are skipped). If a file is missing or the expected pattern is not found, the script prints **manual follow-up** instructions in the install report.

The installer resolves the host project root using `INIT_CWD` / `npm_config_local_prefix`, so `postinstall` targets the storefront root (not `node_modules`).

### Requirements

- EDS storefront with the standard structure (`blocks/`, `scripts/`, `config.json`).
- Authentication drop-in (`@dropins/storefront-auth`) and a `commerce-login` block that matches the SignIn render pattern expected by the installer (see below).
- Social login runtime base URL in `public.default.social-login.app-base-url` (the package **does not write** `config.json`; it only reports when the key is missing).

### Installation

Run from the storefront root:

```bash
npm install @improntus/saas-app-storefront-social-login
```

### What `postinstall` does automatically

1. Copies `assets/blocks/improntus-social-login/*` from the package to `blocks/improntus-social-login/` in the host project.
2. If `blocks/commerce-login/commerce-login.js` exists and matches expected anchors, inserts the import and the **`mountImprontusSocialLogin(block)`** call (see tables below).
3. Reads `config.json` for reporting only: if it cannot find `social-login` and `app-base-url`, it suggests adding them manually.

### Files generated / installed by the package

Source inside the published package -> destination in your project:

| Source (in package) | Destination (in your project) |
| --- | --- |
| `assets/blocks/improntus-social-login/improntus-social-login.js` | `blocks/improntus-social-login/improntus-social-login.js` |
| `assets/blocks/improntus-social-login/improntus-social-login.css` | `blocks/improntus-social-login/improntus-social-login.css` |
| `assets/blocks/improntus-social-login/images/facebook-logo.svg` | `blocks/improntus-social-login/images/facebook-logo.svg` |
| `assets/blocks/improntus-social-login/images/google-logo.svg` | `blocks/improntus-social-login/images/google-logo.svg` |
| `assets/blocks/improntus-social-login/README.md` | `blocks/improntus-social-login/README.md` (documentation copied with the block) |

At runtime, the block uses absolute paths under `/blocks/improntus-social-login/` (for example CSS and icons), consistent with the copied folder.

### Storefront files the installer may modify

| Host file | What the installer does |
| --- | --- |
| `blocks/commerce-login/commerce-login.js` | Inserts the social login import **after** the import from `../../scripts/commerce.js` (if missing). Inserts `mountImprontusSocialLogin(block);` **after** `await authRenderer.render(SignIn, { ... })(block);` (if missing). |
| `config.json` | **Not modified.** If the installer cannot find `"social-login"` and `"app-base-url"` in the file, the install report asks you to configure the runtime URL manually. |

### Code lines added in `blocks/commerce-login/commerce-login.js`

The script looks for an import block **exactly** in this format (including line breaks and commas):

```javascript
import {
  CUSTOMER_ACCOUNT_PATH,
  CUSTOMER_FORGOTPASSWORD_PATH,
  checkIsAuthenticated,
  rootLink,
} from '../../scripts/commerce.js';
```

**Immediately after**, it inserts this line (once):

```javascript
import { mountImprontusSocialLogin } from '../improntus-social-login/improntus-social-login.js';
```

Then it looks for this **exact** block (SignIn render with both routes):

```javascript
    await authRenderer.render(SignIn, {
      routeForgotPassword: () => rootLink(CUSTOMER_FORGOTPASSWORD_PATH),
      routeRedirectOnSignIn: () => rootLink(CUSTOMER_ACCOUNT_PATH),
    })(block);
```

**Immediately after**, it inserts:

```javascript
    mountImprontusSocialLogin(block);
```

If your `commerce-login.js` differs (different formatting, import order, or render pattern), the installer avoids partial rewrites and the report provides equivalent manual steps.

### Required `config.json` setup (manual)

The block reads the App Builder / Adobe I/O Runtime base URL via `getConfigValue('social-login.app-base-url')` (equivalent to `public.default.social-login.app-base-url` in `config.json`). Minimum example inside `public.default`:

```json
"social-login": {
  "app-base-url": "https://<your-project>.adobeioruntime.net"
}
```

Without this, runtime GraphQL configuration loading and popup/callback flows will not have a valid base URL.

### Re-run installer

```bash
npx storefront-social-login-install
```

Or:

```bash
node node_modules/@improntus/saas-app-storefront-social-login/scripts/install.js
```

### Manual integration (without auto patching)

1. Copy `blocks/improntus-social-login/` (same content published under `assets/blocks/improntus-social-login/`).
2. In `blocks/commerce-login/commerce-login.js`, add the import and `mountImprontusSocialLogin(block);` as shown above.
3. Configure `public.default.social-login.app-base-url` in `config.json`.

---

## Block Integration

### Block configuration

This block does not use `readBlockConfig()`. It is mounted programmatically with `renderImprontusSocialLogin(container)` or `mountImprontusSocialLogin(loginRoot)` from the authentication flow (for example, after rendering `SignIn` in `commerce-login`).

### URL parameters (popup / external service)

- `type` - Provider (`facebook` or `google`).
- `returnUrl` - Site origin used by the social login callback service.

### Cookies

After a successful login:

- `auth_dropin_user_token` - Customer token for drop-in auth.
- `auth_dropin_firstname` - First name for UI personalization.

Cookies are written with `SameSite=Lax`, `path=/`, and `Secure` except on `localhost` / `127.0.0.1`.

### Events

- **Emits:** `events.emit('authenticated', true)` when authentication succeeds.
- **Listens:** `window.message` for payloads from the expected social login runtime origin.

## User flow

1. User clicks Facebook or Google.
2. A centered popup opens to the social login endpoint (or Facebook SDK flow for that provider).
3. The external service posts a message back to the opener window.
4. The block validates origin, extracts the token, and fetches customer data.
5. It writes cookies, emits `authenticated`, and reloads or redirects to account based on configuration.

If the browser blocks popups, the flow falls back to full-page navigation to the social login URL.

## Mounting pattern

- `decorate()` is intentionally a no-op.
- UI is injected when the sign-in container becomes available (for example via `MutationObserver` in `mountImprontusSocialLogin`).
- A guard prevents duplicate social login sections in the same container.

## Error handling

- Ignores messages from unexpected origins.
- Explicit `improntus-social-login-error` payloads are logged without breaking the auth modal.
- Validates token presence before processing.
- Missing token/customer-data errors are handled in a controlled way; token login failures are caught to avoid breaking page runtime.

## Block files

- `improntus-social-login.js` - Render, popup flow, message listener, and token handoff.
- `improntus-social-login.css` - Section, button, and icon styles.
- `images/facebook-logo.svg` - Facebook icon.
- `images/google-logo.svg` - Google icon.

## Author

[![N|Solid](https://improntus.com/wp-content/uploads/2022/05/Logo-Site.png)](https://www.improntus.com)