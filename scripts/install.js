#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Social Login installer for Adobe Commerce dropins + AEM EDS.
 * - Copies block assets into host project
 * - Applies idempotent integration patches when target files exist
 * - Prints a final report with manual follow-up items if needed
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const PKG_ROOT = path.resolve(__dirname, '..');
const ASSETS_ROOT = path.join(PKG_ROOT, 'assets');

function resolveHostProjectRoot() {
  if (process.env.INIT_CWD) return path.resolve(process.env.INIT_CWD);
  if (process.env.npm_config_local_prefix) {
    return path.resolve(process.env.npm_config_local_prefix);
  }
  return path.resolve(process.cwd());
}

const PROJECT_ROOT = resolveHostProjectRoot();
const BLOCK_REL_PATH = 'blocks/improntus-social-login';
const COMMERCE_LOGIN_REL_PATH = 'blocks/commerce-login/commerce-login.js';
const HEADER_AUTH_DROPDOWN_REL_PATH = 'blocks/header/renderAuthDropdown.js';
const HEADER_AUTH_COMBINE_REL_PATH = 'blocks/header/renderAuthCombine.js';

const REPORT = {
  patched: [],
  skipped: [],
  manual: [],
};

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function writeText(filePath, content) {
  fs.writeFileSync(filePath, content, 'utf8');
}

function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function copyDirRecursive(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  ensureDir(destDir);
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      copyFile(srcPath, destPath);
    }
  }
}

function insertAfter(content, needle, insertion) {
  if (!content.includes(needle)) return null;
  return content.replace(needle, `${needle}${insertion}`);
}

function insertBefore(content, needle, insertion) {
  if (!content.includes(needle)) return null;
  return content.replace(needle, `${insertion}${needle}`);
}

function askQuestion(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function copyAssets() {
  const src = path.join(ASSETS_ROOT, 'blocks', 'improntus-social-login');
  const dest = path.join(PROJECT_ROOT, BLOCK_REL_PATH);
  if (!fs.existsSync(src)) {
    REPORT.skipped.push('assets/blocks/improntus-social-login (missing in package)');
    return;
  }
  copyDirRecursive(src, dest);
  REPORT.patched.push(`${BLOCK_REL_PATH}: copied package assets`);
}

function patchCommerceLogin() {
  const filePath = path.join(PROJECT_ROOT, COMMERCE_LOGIN_REL_PATH);
  if (!fs.existsSync(filePath)) {
    REPORT.skipped.push(`${COMMERCE_LOGIN_REL_PATH} (missing)`);
    REPORT.manual.push(`Import and call social login mount in \`${COMMERCE_LOGIN_REL_PATH}\`.`);
    return;
  }

  let content = readText(filePath);
  let changed = false;

  const importLine = "import { mountImprontusSocialLogin } from '../improntus-social-login/improntus-social-login.js';";
  if (!content.includes(importLine)) {
    const importAnchor = "import {\n  CUSTOMER_ACCOUNT_PATH,\n  CUSTOMER_FORGOTPASSWORD_PATH,\n  checkIsAuthenticated,\n  rootLink,\n} from '../../scripts/commerce.js';";
    const patchedWithImport = insertAfter(content, importAnchor, `\n${importLine}`);
    if (patchedWithImport) {
      content = patchedWithImport;
      changed = true;
    } else {
      REPORT.manual.push(`Add \`${importLine}\` to \`${COMMERCE_LOGIN_REL_PATH}\`.`);
    }
  }

  if (!content.includes('mountImprontusSocialLogin(block);')) {
    const signInRenderNeedle = `    await authRenderer.render(SignIn, {\n      routeForgotPassword: () => rootLink(CUSTOMER_FORGOTPASSWORD_PATH),\n      routeRedirectOnSignIn: () => rootLink(CUSTOMER_ACCOUNT_PATH),\n    })(block);`;
    const patchedWithMount = insertAfter(content, signInRenderNeedle, '\n    mountImprontusSocialLogin(block);');
    if (patchedWithMount) {
      content = patchedWithMount;
      changed = true;
    } else {
      REPORT.manual.push(`Add \`mountImprontusSocialLogin(block);\` after SignIn render in \`${COMMERCE_LOGIN_REL_PATH}\`.`);
    }
  }

  if (changed) {
    writeText(filePath, content);
    REPORT.patched.push(`${COMMERCE_LOGIN_REL_PATH}: injected social login import and mount call`);
  } else {
    REPORT.skipped.push(`${COMMERCE_LOGIN_REL_PATH} (already patched or requires manual merge)`);
  }
}

function patchHeaderRenderAuthDropdown() {
  const relPath = HEADER_AUTH_DROPDOWN_REL_PATH;
  const filePath = path.join(PROJECT_ROOT, relPath);
  if (!fs.existsSync(filePath)) {
    REPORT.skipped.push(`${relPath} (missing)`);
    REPORT.manual.push(`Integrate social login rendering in \`${relPath}\`.`);
    return;
  }

  let content = readText(filePath);
  let changed = false;

  const importLine = "import { renderImprontusSocialLogin } from '../improntus-social-login/improntus-social-login.js';";
  if (!content.includes(importLine)) {
    const importAnchor = "import { loadCSS } from '../../scripts/aem.js';";
    const patchedWithImport = insertAfter(content, importAnchor, `\n${importLine}`);
    if (patchedWithImport) {
      content = patchedWithImport;
      changed = true;
    } else {
      REPORT.manual.push(`Add \`${importLine}\` to \`${relPath}\`.`);
    }
  }

  const mountHelper = `\n  loadCSS('/blocks/improntus-social-login/improntus-social-login.css').catch(() => {});\n\n  const mountImprontusSocialLogin = () => {\n    const signInButtons = element.querySelector('.auth-sign-in-form__form__buttons');\n    const signInContainer = signInButtons?.parentElement;\n\n    if (!signInContainer) return false;\n    if (signInContainer.querySelector('.improntus-social-login')) return true;\n\n    renderImprontusSocialLogin(signInContainer);\n    return true;\n  };\n`;
  if (!content.includes("const mountImprontusSocialLogin = () => {")) {
    const functionAnchor = 'function renderSignIn(element) {\n';
    const patchedWithMountHelper = insertAfter(content, functionAnchor, mountHelper);
    if (patchedWithMountHelper) {
      content = patchedWithMountHelper;
      changed = true;
    } else {
      REPORT.manual.push(`Add social login mount helper inside \`renderSignIn\` in \`${relPath}\`.`);
    }
  }

  if (changed) {
    writeText(filePath, content);
    REPORT.patched.push(`${relPath}: injected social login import and SignIn mount helper`);
  } else {
    REPORT.skipped.push(`${relPath} (already patched or requires manual merge)`);
  }
}

function patchHeaderRenderAuthCombine() {
  const relPath = HEADER_AUTH_COMBINE_REL_PATH;
  const filePath = path.join(PROJECT_ROOT, relPath);
  if (!fs.existsSync(filePath)) {
    REPORT.skipped.push(`${relPath} (missing)`);
    REPORT.manual.push(`Integrate social login rendering in \`${relPath}\`.`);
    return;
  }

  let content = readText(filePath);
  let changed = false;

  const importLine = "import { renderImprontusSocialLogin } from '../improntus-social-login/improntus-social-login.js';";
  if (!content.includes(importLine)) {
    const importAnchor = "import { loadCSS } from '../../scripts/aem.js';";
    const patchedWithImport = insertAfter(content, importAnchor, `\n${importLine}`);
    if (patchedWithImport) {
      content = patchedWithImport;
      changed = true;
    } else {
      REPORT.manual.push(`Add \`${importLine}\` to \`${relPath}\`.`);
    }
  }

  const mountFunction = `function mountImprontusSocialLogin(signInFormRoot) {\n  if (!signInFormRoot) return;\n\n  loadCSS('/blocks/improntus-social-login/improntus-social-login.css').catch(() => {});\n\n  const tryMount = () => {\n    const signInButtons = signInFormRoot.querySelector('.auth-sign-in-form__form__buttons');\n    const signInContainer = signInButtons?.parentElement;\n    if (!signInContainer) return false;\n    if (signInContainer.querySelector('.improntus-social-login')) return true;\n\n    renderImprontusSocialLogin(signInContainer);\n    return true;\n  };\n\n  const observer = new MutationObserver(() => {\n    if (!document.body.contains(signInFormRoot)) {\n      observer.disconnect();\n      return;\n    }\n    tryMount();\n  });\n\n  observer.observe(signInFormRoot, {\n    childList: true,\n    subtree: true,\n  });\n\n  tryMount();\n}\n\n`;
  if (!content.includes('function mountImprontusSocialLogin(signInFormRoot) {')) {
    const mountFunctionAnchor = 'const onHeaderLinkClick = (element) => {\n';
    const patchedWithMountFunction = insertBefore(content, mountFunctionAnchor, mountFunction);
    if (patchedWithMountFunction) {
      content = patchedWithMountFunction;
      changed = true;
    } else {
      REPORT.manual.push(`Add \`mountImprontusSocialLogin(signInFormRoot)\` helper in \`${relPath}\`.`);
    }
  }

  if (!content.includes('mountImprontusSocialLogin(signInForm);')) {
    const renderNeedle = `  authRenderer.render(AuthCombine, {\n    signInFormConfig,\n    signUpFormConfig,\n    resetPasswordFormConfig,\n  })(signInForm);`;
    const patchedWithCall = insertAfter(content, renderNeedle, '\n\n  mountImprontusSocialLogin(signInForm);');
    if (patchedWithCall) {
      content = patchedWithCall;
      changed = true;
    } else {
      REPORT.manual.push(`Call \`mountImprontusSocialLogin(signInForm);\` after AuthCombine render in \`${relPath}\`.`);
    }
  }

  if (changed) {
    writeText(filePath, content);
    REPORT.patched.push(`${relPath}: injected social login import, helper, and mount call`);
  } else {
    REPORT.skipped.push(`${relPath} (already patched or requires manual merge)`);
  }
}

async function promptAndUpdateConfig() {
  const relPath = 'config.json';
  const filePath = path.join(PROJECT_ROOT, relPath);
  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

  if (!fs.existsSync(filePath)) {
    REPORT.manual.push('Create `config.json` and set `public.default.social-login.app-base-url`.');
    return;
  }

  let parsedConfig;
  try {
    parsedConfig = JSON.parse(readText(filePath));
  } catch (error) {
    REPORT.manual.push('`config.json` is not valid JSON. Update it manually with `public.default.social-login.app-base-url`.');
    return;
  }

  if (!isInteractive) {
    REPORT.manual.push('Non-interactive install detected. Set `public.default.social-login.app-base-url` manually in `config.json`.');
    return;
  }

  console.log('\nSocial Login configuration');
  console.log('--------------------------');
  const answer = await askQuestion('Enter your Social Login app base URL (e.g. https://123456-yourappname.adobeioruntime.net): ');

  if (!answer) {
    REPORT.manual.push('No app base URL provided. Set `public.default.social-login.app-base-url` manually in `config.json`.');
    return;
  }

  if (typeof parsedConfig.public !== 'object' || parsedConfig.public === null) {
    parsedConfig.public = {};
  }
  if (typeof parsedConfig.public.default !== 'object' || parsedConfig.public.default === null) {
    parsedConfig.public.default = {};
  }

  const existingSocialLogin = parsedConfig.public.default['social-login'];
  if (typeof existingSocialLogin !== 'object' || existingSocialLogin === null) {
    parsedConfig.public.default['social-login'] = {};
  }

  parsedConfig.public.default['social-login']['app-base-url'] = answer;

  try {
    writeText(filePath, `${JSON.stringify(parsedConfig, null, 2)}\n`);
    REPORT.patched.push(`${relPath}: set public.default.social-login.app-base-url`);
  } catch (error) {
    REPORT.manual.push('Failed to update `config.json`. Set `public.default.social-login.app-base-url` manually.');
  }
}

function printReport() {
  console.log('\n@improntus/saas-app-storefront-social-login install report');
  console.log('-----------------------------------------------------------');
  if (REPORT.patched.length) {
    console.log('\nPatched files:');
    REPORT.patched.forEach((line) => console.log(`- ${line}`));
  }
  if (REPORT.skipped.length) {
    console.log('\nSkipped files:');
    REPORT.skipped.forEach((line) => console.log(`- ${line}`));
  }
  if (REPORT.manual.length) {
    console.log('\nManual follow-up required:');
    REPORT.manual.forEach((line) => console.log(`- ${line}`));
  }
  console.log('\nDone.');
}

async function main() {
  copyAssets();
  patchCommerceLogin();
  patchHeaderRenderAuthDropdown();
  patchHeaderRenderAuthCombine();
  await promptAndUpdateConfig();
  printReport();
}

main();
