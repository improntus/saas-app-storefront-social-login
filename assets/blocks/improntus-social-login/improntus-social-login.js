import * as authApi from '@dropins/storefront-auth/api.js';
import { getConfigValue } from '@dropins/tools/lib/aem/configs.js';
import { events } from '@dropins/tools/event-bus.js';
import { loadCSS } from '../../scripts/aem.js';
import { checkIsAuthenticated, CUSTOMER_ACCOUNT_PATH, rootLink } from '../../scripts/commerce.js';

const SOCIAL_LOGIN_PATH_LOGIN = '/api/v1/web/sociallogin/login';
const SOCIAL_LOGIN_PATH_GRAPHQL = '/api/v1/web/sociallogin/graphql';
const SOCIAL_LOGIN_PATH_CALLBACK = '/api/v1/web/sociallogin/callback';
const FACEBOOK_SDK_ID = 'facebook-jssdk';
const FACEBOOK_SDK_URL = 'https://connect.facebook.net/en_US/sdk.js';
const FACEBOOK_SDK_VERSION = 'v25.0';
const FACEBOOK_SCOPE = 'public_profile,email';
const SOCIAL_LOGIN_MESSAGE_TYPE = 'improntus-social-login-success';
const SOCIAL_LOGIN_ERROR_TYPE = 'improntus-social-login-error';
const CUSTOMER_DATA_NO_CACHE_QUERY = `
  query GET_CUSTOMER_DATA_NO_CACHE {
    customer {
      firstname
      lastname
      email
      group {
        uid
      }
    }
  }
`;
let socialLoginListenerInitialized = false;

/** @type {Record<string, unknown> | null | undefined} undefined = not loaded yet */
let socialLoginConfigCache;
let socialLoginConfigPromise = null;

const GET_SOCIAL_LOGIN_CONFIG = `
  query GetSocialLoginConfig {
    socialLoginConfig {
      enable_social_login
      login_title_text
      login_button_google_text
      login_button_facebook_text
      google_enabled
      facebook_enabled
      facebook_app_id
      redirect_to_account_after_login
    }
  }
`;

function normalizeSocialLoginBaseUrl(base) {
  if (base == null || typeof base !== 'string') return '';
  return base.trim().replace(/\/+$/, '');
}

/**
 * URLs del runtime de social login (desde `social-login.app-base-url` en config.json).
 * @returns {{ base: string, login: string, graphql: string, callback: string, origin: string } | null}
 */
function getSocialLoginRuntimeUrls() {
  const base = normalizeSocialLoginBaseUrl(getConfigValue('social-login.app-base-url'));
  if (!base) return null;
  let origin = '';
  try {
    origin = new URL(base).origin;
  } catch {
    return null;
  }
  return {
    base,
    login: `${base}${SOCIAL_LOGIN_PATH_LOGIN}`,
    graphql: `${base}${SOCIAL_LOGIN_PATH_GRAPHQL}`,
    callback: `${base}${SOCIAL_LOGIN_PATH_CALLBACK}`,
    origin,
  };
}

function isConfigYes(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === '1';
}

const SOCIAL_LOGIN_FETCH_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
};

/** Headers de ámbito Commerce desde `public.*.headers.cs` en config.json */
function getSocialLoginCommerceScopeHeaders() {
  /** @type {Record<string, string>} */
  const out = {};
  const entries = [
    ['Magento-Store-Code', 'headers.cs.Magento-Store-Code'],
    ['Magento-Store-View-Code', 'headers.cs.Magento-Store-View-Code'],
    ['Magento-Website-Code', 'headers.cs.Magento-Website-Code'],
  ];
  for (const [headerName, configPath] of entries) {
    const value = getConfigValue(configPath);
    if (value != null && String(value).trim() !== '') {
      out[headerName] = String(value).trim();
    }
  }
  return out;
}

function getSocialLoginGraphqlRequestHeaders() {
  return {
    ...SOCIAL_LOGIN_FETCH_HEADERS,
    ...getSocialLoginCommerceScopeHeaders(),
  };
}

/**
 * Loads social login config from App Builder GraphQL (cached).
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function fetchSocialLoginConfig() {
  if (checkIsAuthenticated()) {
    return null;
  }
  if (socialLoginConfigCache !== undefined) {
    return socialLoginConfigCache;
  }
  if (socialLoginConfigPromise) {
    return socialLoginConfigPromise;
  }

  socialLoginConfigPromise = (async () => {
    const urls = getSocialLoginRuntimeUrls();
    if (!urls?.graphql) {
      throw new Error('Missing social-login.app-base-url in config.json (public.default.social-login.app-base-url).');
    }
    const response = await fetch(urls.graphql, {
      method: 'POST',
      headers: getSocialLoginGraphqlRequestHeaders(),
      body: JSON.stringify({
        query: GET_SOCIAL_LOGIN_CONFIG,
        variables: {},
      }),
      credentials: 'omit',
      cache: 'no-store',
    });

    if (!response.ok) {
      throw new Error(`Social login config request failed with status ${response.status}`);
    }

    const payload = await response.json();
    if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
      const message = payload.errors.map((e) => e?.message || String(e)).join('; ');
      throw new Error(message || 'GraphQL errors loading social login config');
    }

    const config = payload?.data?.socialLoginConfig ?? null;
    socialLoginConfigCache = config && typeof config === 'object' ? config : null;
    return socialLoginConfigCache;
  })();

  try {
    const result = await socialLoginConfigPromise;
    return result;
  } catch (error) {
    socialLoginConfigPromise = null;
    throw error;
  }
}

function getSocialLoginConfigSync() {
  return socialLoginConfigCache === undefined ? null : socialLoginConfigCache;
}

function getFacebookAppId() {
  const fromApi = getSocialLoginConfigSync()?.facebook_app_id;
  if (fromApi != null && String(fromApi).trim()) {
    return String(fromApi).trim();
  }
  return window.FACEBOOK_APP_ID
    || window.fbAppId
    || document.body?.dataset?.facebookAppId
    || '';
}

function buildFacebookOAuthFallbackUrl(appId) {
  const urls = getSocialLoginRuntimeUrls();
  if (!urls?.callback) {
    window.console.error('Facebook OAuth fallback skipped: missing social-login.app-base-url in config.json.');
    return '';
  }
  const target = new URL('https://www.facebook.com/v25.0/dialog/oauth');
  target.searchParams.set('client_id', String(appId || ''));
  target.searchParams.set('redirect_uri', urls.callback);
  target.searchParams.set('response_type', 'token');
  target.searchParams.set('scope', FACEBOOK_SCOPE);
  return target.toString();
}

async function redirectWithFacebookToken(accessToken) {
  const urls = getSocialLoginRuntimeUrls();
  if (!urls?.callback) {
    throw new Error('Missing social-login.app-base-url in config.json for Facebook callback URL.');
  }
  const target = new URL(urls.callback);
  target.searchParams.set('type', 'facebook');
  target.searchParams.set('access_token', String(accessToken || ''));
  target.searchParams.set('_ts', String(Date.now()));

  const response = await fetch(target.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    credentials: 'omit',
  });

  if (!response.ok) {
    throw new Error(`Facebook social login request failed with status ${response.status}`);
  }

  const payload = await response.json();
  const customerToken = payload?.customer_token || payload?.customerToken || '';
  const isSuccess = payload?.success !== false;

  if (!isSuccess || !customerToken) {
    throw new Error('Facebook social login did not return a valid customer token.');
  }

  await loginWithCustomerToken(customerToken);
}

function loadFacebookSdk() {
  return new Promise((resolve, reject) => {
    if (window.FB) {
      resolve(window.FB);
      return;
    }

    const existingScript = document.getElementById(FACEBOOK_SDK_ID);
    if (existingScript) {
      const onLoad = () => {
        if (window.FB) resolve(window.FB);
        else reject(new Error('Facebook SDK loaded but FB is unavailable.'));
      };
      existingScript.addEventListener('load', onLoad, { once: true });
      existingScript.addEventListener('error', () => reject(new Error('Failed to load Facebook SDK.')), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.id = FACEBOOK_SDK_ID;
    script.src = FACEBOOK_SDK_URL;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      if (window.FB) {
        resolve(window.FB);
      } else {
        reject(new Error('Facebook SDK loaded but FB is unavailable.'));
      }
    };
    script.onerror = () => reject(new Error('Failed to load Facebook SDK.'));
    document.head.appendChild(script);
  });
}

function loginWithFacebookSdk() {
  if (!getSocialLoginRuntimeUrls()?.callback) {
    window.console.error('Facebook login skipped: missing social-login.app-base-url in config.json.');
    return;
  }

  const appId = getFacebookAppId();
  if (!appId) {
    window.console.error('Facebook app id is not configured. Set window.FACEBOOK_APP_ID or data-facebook-app-id on body.');
    return;
  }

  const fallbackToOAuth = () => {
    const fallbackUrl = buildFacebookOAuthFallbackUrl(appId);
    if (fallbackUrl) {
      window.location.assign(fallbackUrl);
    }
  };

  const sdkTimeout = window.setTimeout(fallbackToOAuth, 4000);

  loadFacebookSdk()
    .then((fb) => {
      window.clearTimeout(sdkTimeout);
      fb.init({
        appId,
        xfbml: true,
        version: FACEBOOK_SDK_VERSION,
      });

      fb.login((response) => {
        const accessToken = response?.authResponse?.accessToken;
        if (accessToken) {
          redirectWithFacebookToken(accessToken)
            .catch((error) => {
              window.console.error('Failed to exchange Facebook token for customer token.', error);
            });
          return;
        }
        window.console.error('Facebook login was cancelled or not authorized.');
      }, { scope: FACEBOOK_SCOPE });
    })
    .catch((error) => {
      window.clearTimeout(sdkTimeout);
      window.console.error('Facebook SDK flow failed, using OAuth fallback.', error);
      fallbackToOAuth();
    });
}

function getCookieSecureAttribute() {
  const localhostHosts = ['localhost', '127.0.0.1'];
  return localhostHosts.includes(window.location.hostname) ? '' : '; Secure';
}

function setAuthCookie(name, value) {
  const secureAttribute = getCookieSecureAttribute();
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; SameSite=Lax${secureAttribute}`;
}

async function loginWithCustomerToken(customerToken) {
  if (!customerToken) throw new Error('Missing customer token.');

  const config = getSocialLoginConfigSync();
  const redirectToAccount = isConfigYes(config?.redirect_to_account_after_login);

  let customerData = await authApi.getCustomerData(customerToken);
  if (!customerData?.firstName) {
    authApi.setFetchGraphQlHeader('Authorization', `Bearer ${customerToken}`);
    const response = await authApi.fetchGraphQl(CUSTOMER_DATA_NO_CACHE_QUERY, {
      method: 'POST',
      cache: 'no-cache',
    });
    const customer = response?.data?.customer;
    customerData = customer
      ? {
        firstName: customer.firstname || '',
        lastName: customer.lastname || '',
        email: customer.email || '',
        groupUid: customer.group?.uid || '',
      }
      : null;
  }

  if (!customerData?.firstName) {
    throw new Error('Could not fetch customer data from token.');
  }

  setAuthCookie('auth_dropin_user_token', customerToken);
  setAuthCookie('auth_dropin_firstname', customerData.firstName);
  events.emit('authenticated', true);
  if (redirectToAccount) {
    window.location.href = rootLink(CUSTOMER_ACCOUNT_PATH);
  } else {
    window.location.reload();
  }
}

function extractCustomerToken(payload) {
  if (!payload) return '';
  if (typeof payload === 'string') return payload;
  if (payload.type === SOCIAL_LOGIN_MESSAGE_TYPE && payload.token) return payload.token;
  if (payload.customerToken) return payload.customerToken;
  return '';
}

function initializeSocialLoginMessageListener() {
  if (socialLoginListenerInitialized) return;
  socialLoginListenerInitialized = true;

  window.addEventListener('message', async (event) => {
    const urls = getSocialLoginRuntimeUrls();
    const expectedOrigin = urls?.origin;
    if (!expectedOrigin || event.origin !== expectedOrigin) return;

    if (event.data?.type === SOCIAL_LOGIN_ERROR_TYPE) {
      // Keep error handling lightweight to avoid breaking the sign-in flow.
      window.console.error('Social login returned an error response.', event.data);
      return;
    }

    const customerToken = extractCustomerToken(event.data);
    if (!customerToken) return;

    try {
      if (socialLoginConfigCache === undefined) {
        await fetchSocialLoginConfig().catch(() => {});
      }
      await loginWithCustomerToken(customerToken);
    } catch (error) {
      window.console.error('Failed to complete social login using customer token.', error);
    }
  });
}

function openSocialLoginPopup(provider) {
  if (provider === 'facebook') {
    loginWithFacebookSdk();
    return;
  }

  const urls = getSocialLoginRuntimeUrls();
  if (!urls?.login) {
    window.console.error('Google social login popup skipped: missing social-login.app-base-url in config.json.');
    return;
  }

  const returnUrl = window.location.origin;
  const popupUrlObject = new URL(urls.login);
  popupUrlObject.searchParams.set('type', provider);
  popupUrlObject.searchParams.set('returnUrl', returnUrl);
  popupUrlObject.searchParams.set('_ts', String(Date.now()));
  const popupUrl = popupUrlObject.toString();
  const width = 560;
  const height = 700;
  const left = window.screenX + Math.max(0, (window.outerWidth - width) / 2);
  const top = window.screenY + Math.max(0, (window.outerHeight - height) / 2);
  const features = [
    `width=${Math.round(width)}`,
    `height=${Math.round(height)}`,
    `left=${Math.round(left)}`,
    `top=${Math.round(top)}`,
    'resizable=yes',
    'scrollbars=yes',
  ].join(',');

  const popup = window.open(popupUrl, `improntus-social-login-${provider}`, features);

  if (!popup) {
    // Fallback when popup blockers are enabled.
    window.location.href = popupUrl;
    return;
  }

  popup.focus();
}

function createSocialButton(provider, label, iconPath, className) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `improntus-social-login__button ${className}`;
  button.setAttribute('aria-label', label);

  const icon = document.createElement('img');
  icon.className = 'improntus-social-login__icon';
  icon.src = iconPath;
  icon.alt = '';
  icon.width = 21;
  icon.height = 21;
  icon.loading = 'lazy';

  const text = document.createElement('span');
  text.className = 'improntus-social-login__text';
  text.textContent = label;

  button.append(icon, text);

  button.addEventListener('click', () => {
    openSocialLoginPopup(provider);
  });

  return button;
}

export async function renderImprontusSocialLogin(container) {
  if (checkIsAuthenticated()) return;
  if (!container || container.querySelector('.improntus-social-login')) return;
  if (container.__improntusSocialLoginMountPromise) {
    return container.__improntusSocialLoginMountPromise;
  }

  initializeSocialLoginMessageListener();

  container.__improntusSocialLoginMountPromise = (async () => {
    let config;
    try {
      config = await fetchSocialLoginConfig();
    } catch (error) {
      window.console.error('Could not load social login configuration.', error);
      return;
    }

    if (!isConfigYes(config?.enable_social_login)) {
      return;
    }

    if (container.querySelector('.improntus-social-login')) {
      return;
    }

    const wrapper = document.createElement('section');
    wrapper.className = 'improntus-social-login';

    const title = document.createElement('h3');
    title.className = 'improntus-social-login__title';
    title.textContent = (config?.login_title_text && String(config.login_title_text).trim())
      || 'Inicio de sesion mediante Redes Sociales';

    const actions = document.createElement('div');
    actions.className = 'improntus-social-login__actions';

    const facebookLabel = (config?.login_button_facebook_text && String(config.login_button_facebook_text).trim())
      || 'CUENTA DE FACEBOOK';
    const googleLabel = (config?.login_button_google_text && String(config.login_button_google_text).trim())
      || 'CUENTA DE GOOGLE';

    if (isConfigYes(config?.facebook_enabled)) {
      actions.append(createSocialButton(
        'facebook',
        facebookLabel,
        '/blocks/improntus-social-login/images/facebook-logo.svg',
        'improntus-social-login__button--facebook',
      ));
    }

    if (isConfigYes(config?.google_enabled)) {
      actions.append(createSocialButton(
        'google',
        googleLabel,
        '/blocks/improntus-social-login/images/google-logo.svg',
        'improntus-social-login__button--google',
      ));
    }

    if (!actions.children.length) {
      return;
    }

    wrapper.append(title, actions);
    container.append(wrapper);
  })();

  try {
    await container.__improntusSocialLoginMountPromise;
  } finally {
    delete container.__improntusSocialLoginMountPromise;
  }
}

/**
 * Monta el UI de social login dentro del contenedor del drop-in SignIn (commerce-login).
 * Observa el DOM hasta que exista el formulario y luego desconecta el observer.
 * @param {HTMLElement | null | undefined} loginRoot - nodo raiz donde se renderizo SignIn
 */
export function mountImprontusSocialLogin(loginRoot) {
  if (checkIsAuthenticated()) return;
  if (!loginRoot) return;

  loadCSS('/blocks/improntus-social-login/improntus-social-login.css').catch(() => {});

  const tryMount = () => {
    const signInButtons = loginRoot.querySelector('.auth-sign-in-form__form__buttons');
    const signInContainer = signInButtons?.parentElement;
    if (!signInContainer) return false;
    if (signInContainer.querySelector('.improntus-social-login')) return true;

    renderImprontusSocialLogin(signInContainer);
    return true;
  };

  const observer = new MutationObserver(() => {
    if (!document.body.contains(loginRoot)) {
      observer.disconnect();
      return;
    }
    if (tryMount()) {
      observer.disconnect();
    }
  });

  observer.observe(loginRoot, {
    childList: true,
    subtree: true,
  });

  if (tryMount()) {
    observer.disconnect();
  }
}

export default function decorate() {
  // no-op: this block is mounted programmatically inside the sign-in modal.
}
