// Library resources are Custom Nodes: validation of a saved node and of an icon.
'use strict';

// Accidental-edit fingerprint, not a package signature or an authorization decision.
function resourceContentChecksum(payload) {
  const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' :
    value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' :
      JSON.stringify(value === undefined ? null : value);
  const text = canonical({...payload, plugin: undefined});
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return 'fnv1a-' + hash.toString(16).padStart(8, '0');
}

function validateIcon(value = '') {
  if (
    typeof value !== 'string' ||
    !(
      (value.length <= 30 && /^[a-z0-9_-]*$/i.test(value)) ||
      (value.length <= 100000 && /^data:image\/png;base64,[a-z0-9+/]+=*$/i.test(value)) ||
      (value.length <= 150000 && /^data:image\/svg\+xml,%3C/i.test(value))
    )
  )
    throw bad('The icon must be a name, a PNG image (100000 characters) or an encoded SVG image (150000 characters).');
}
function validateResource(payload) {
  if (!isObject(payload)) throw bad('Invalid payload.');
  checkManifest(payload);
  const bundle = payload.bundle;
  if (!isObject(bundle) || bundle.version !== BUNDLE_VERSION || !Array.isArray(bundle.groups) || !bundle.groups.length)
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
}
