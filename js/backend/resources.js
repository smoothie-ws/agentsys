// Library resources (providers, skills, Custom Nodes): validation, and the OpenAI-compatible
// provider client behind the llm API route.
'use strict';

// ----- providers (OpenAI-compatible HTTP APIs called straight from the browser) -----
function validateIcon(value = '') {
  if (
    typeof value !== 'string' ||
    !(
      (value.length <= 30 && /^[a-z0-9_-]*$/i.test(value)) ||
      (value.length <= 100000 && /^data:image\/png;base64,[a-z0-9+/]+=*$/i.test(value))
    )
  )
    throw bad('The icon must be a name or a PNG image of at most 100000 characters.');
}
function validateResource(kind, payload) {
  if (!RESOURCE_KINDS.includes(kind) || !isObject(payload)) throw bad('Unknown resource kind or invalid payload.');
  if (kind === 'provider') {
    if (
      payload.prices !== undefined &&
      (!isObject(payload.prices) || ['input', 'output'].some(k => !finite(payload.prices[k]) || payload.prices[k] < 0))
    )
      throw bad('prices must contain nonnegative input/output rates per million tokens');
    let url;
    try {
      url = new URL(payload.endpoint);
    } catch {
      throw bad('Use an HTTP(S) API base URL without embedded credentials, query or fragment.');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw bad('Use an HTTP(S) API base URL without embedded credentials, query or fragment.');
    for (const k of ['models_path', 'chat_path'])
      if (
        k in payload &&
        (typeof payload[k] !== 'string' || /^(\/|https?:)/.test(payload[k]) || payload[k].includes('..'))
      )
        throw bad('Provider API paths must be relative to the base URL.');
    if (!isObject(payload.headers ?? {}) || !isObject(payload.generation ?? {}))
      throw bad('Headers and generation options must be JSON objects.');
    if (Object.entries(payload.headers ?? {}).some(([k, v]) => typeof k !== 'string' || typeof v !== 'string'))
      throw bad('Header names and values must be strings.');
    if (typeof (payload.api_key ?? '') !== 'string' || typeof (payload.default_model ?? '') !== 'string')
      throw bad('API key and default model must be strings.');
  } else if (kind === 'custom_node') {
    checkManifest(payload);
    const bundle = payload.bundle;
    if (
      !isObject(bundle) ||
      bundle.version !== BUNDLE_VERSION ||
      !Array.isArray(bundle.groups) ||
      !bundle.groups.length
    )
      throw bad('A Custom Node is a group of nodes.');
    validateIcon(payload.icon ?? '');
    if (typeof (payload.description ?? '') !== 'string' || (payload.description ?? '').length > 2000)
      throw bad('Description must be text of at most 2000 characters.');
    if (typeof (payload.folder ?? '') !== 'string' || (payload.folder ?? '').length > 200)
      throw bad('The group must be text of at most 200 characters.');
    if ('folder' in payload)
      payload.folder = String(payload.folder)
        .split('/')
        .map(p => p.trim())
        .filter(Boolean)
        .join('/');
    if (JSON.stringify(bundle).length > 4000000) throw bad('This Custom Node is too large.');
  } else if (kind === 'skill') {
    try {
      SkillFile.read(payload.markdown);
    } catch (error) {
      throw bad(error.message);
    }
    if (typeof (payload.folder ?? '') !== 'string' || (payload.folder || '').length > 200)
      throw bad('Invalid skill group.');
    payload.folder = String(payload.folder || '')
      .split('/')
      .map(p => p.trim())
      .filter(Boolean)
      .join('/');
  }
}

const providerURL = (provider, path) => provider.endpoint.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
async function providerFetch(provider, path, init = {}) {
  provider = await injectSecrets(provider);
  let response;
  try {
    response = await fetch(providerURL(provider, path), {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(provider.api_key ? {Authorization: 'Bearer ' + provider.api_key} : {}),
        ...(provider.headers || {}),
      },
    });
  } catch (error) {
    throw new ApiError(
      'provider_unavailable',
      `Could not connect to the provider (${error.message}). Browsers need the server to allow cross-origin requests (CORS).`,
      502
    );
  }
  if (!response.ok) {
    const error = new ApiError(
      'provider_unavailable',
      `The provider answered ${response.status}: ${(await response.text()).slice(0, 300)}`,
      502
    );
    error.providerStatus = response.status;
    throw error;
  }
  return response.json();
}
async function providerModels(provider) {
  const data = await providerFetch(provider, provider.models_path || 'models');
  return (Array.isArray(data) ? data : data.data || []).map(m => (typeof m === 'string' ? m : m.id)).filter(Boolean);
}
