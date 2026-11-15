// Passive plugin content is a separate boundary from sandbox code and host registrations.
'use strict';
const PluginContent = (() => {
  // Escapes/comments can hide resource-loading CSS tokens; plugin CSS has no need for either.
  const unsafeCSS = text => /\\|\/\*|@import|(?:url|image-set|src|expression)\s*\(|behavior\s*:|-moz-binding|javascript:/i.test(text);
  /** Passive HTML from a plugin page or card. Scripts, frames, external styles, event handlers and unsafe URLs are removed. */
  function sanitizeHTML(value) {
    const template = document.createElement('template');
    template.innerHTML = String(value ?? '').slice(0, 300000);
    // HTML elements report an upper-case tagName, namespaced ones (SVG, MathML) keep their lower-case name: compare
    // the local name without case, so `<svg><script>` is removed like `<script>`.
    const banned = new Set([
      'SCRIPT',
      'IFRAME',
      'FRAME',
      'FRAMESET',
      'OBJECT',
      'EMBED',
      'LINK',
      'META',
      'BASE',
      'FORM',
      'STYLE',
      'TEMPLATE',
      'AUDIO',
      'VIDEO',
      'TRACK',
      'SOURCE',
      'USE',
      'IMAGE',
      'ANIMATE',
      'SET',
      'ANIMATETRANSFORM',
    ]);
    const tagged = node => String(node.localName || node.tagName || '').toUpperCase();
    // URL parsers ignore ASCII tabs/newlines inside a scheme (`java&#10;script:` is javascript:), so normalize
    // before matching. A data URL may only be an image in an image element; SVG data can carry script.
    const compactURL = text => String(text || '').replace(/[\u0000-\u0020\u007f-\u009f]+/g, '').toLowerCase();
    const imageData = /^data:image\/(?:png|jpeg|gif|webp)[;,]/;
    const unsafeURL = (text, tag, name) => {
      const value = compactURL(text);
      const attribute = name.toLowerCase();
      // Resource URLs also occur on input[type=image], SVG feImage/textPath and other elements, not just img.
      if (attribute === 'src') return tag !== 'IMG' || !imageData.test(value);
      if (attribute === 'srcset') return true;
      if (['href', 'xlink:href'].includes(attribute) && tag !== 'A') return !value.startsWith('#');
      if (['action', 'formaction', 'ping', 'poster', 'background'].includes(attribute)) return true;
      // Only img.src above accepts data URLs. Links may navigate, but never execute code or open local files.
      if (/^(?:javascript|vbscript|file|data):/.test(value)) return true;
      return false;
    };
    const walk = node => {
      for (const child of [...node.children]) {
        const tag = tagged(child);
        if (banned.has(tag) || (child.namespaceURI && !['http://www.w3.org/1999/xhtml', 'http://www.w3.org/2000/svg'].includes(child.namespaceURI))) {
          child.remove();
          continue;
        }
        for (const attr of [...child.attributes]) {
          const name = attr.name.toLowerCase();
          const text = String(attr.value || '');
          const urlAttribute = /^(?:href|xlink:href|src|srcset|poster|action|formaction|ping|background)$/.test(name);
          if (name.startsWith('on') || name === 'srcdoc' ||
              (name.startsWith('data-') && !['data-command', 'data-args'].includes(name)) ||
              (urlAttribute && unsafeURL(text, tag, name)))
            child.removeAttribute(attr.name);
          else if (/^(?:style|fill|stroke|filter|clip-path|mask|marker-start|marker-mid|marker-end|cursor)$/.test(name) && unsafeCSS(text))
            child.removeAttribute(attr.name);
        }
        if (tag === 'A') {
          child.setAttribute('rel', 'noopener noreferrer');
          if (/^https?:/i.test(child.getAttribute('href') || '')) child.setAttribute('target', '_blank');
          else child.removeAttribute('target');
        }
        walk(child);
      }
    };
    walk(template.content);
    return template.innerHTML;
  }

  /** Sanitized passive HTML with one extra control: a button marked `data-command` runs that plugin's command. */
  function decorateHTML(value, pluginId) {
    const template = document.createElement('template');
    template.innerHTML = sanitizeHTML(value);
    for (const node of template.content.querySelectorAll('[data-command]')) {
      const command = String(node.getAttribute('data-command') || '');
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(command)) {
        node.removeAttribute('data-command');
        continue;
      }
      let args = [];
      try {
        const parsed = JSON.parse(node.getAttribute('data-args') || '[]');
        if (Array.isArray(parsed)) args = parsed.slice(0, 20);
      } catch {}
      node.setAttribute('data-ext-command', `${pluginId}:${command}`);
      if (args.length) node.setAttribute('data-ext-args', JSON.stringify(args));
    }
    return template.innerHTML;
  }

  /** A sidebar item points into this client; a URL of another origin or another scheme is not a destination. */
  function internalHref(value) {
    const text = String(value || '');
    if (text.length > 2000 || !/^\/(?!\/)/.test(text) || /[\\\u0000-\u001f\u007f]/.test(text))
      throw new Error('A sidebar item href must be a path of this client, starting with "/"');
    return text;
  }

  return {sanitize: sanitizeHTML, decorate: decorateHTML, internalHref, unsafeCSS};
})();
