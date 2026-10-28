// The colour picker: saturation/brightness, hue, opacity and RGB(A) hex. It replaces the browser's own colour dialog everywhere.
'use strict';

const hexOf = (h, s, v) => {
  const f = n => {
    const k = (n + h / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return '#' + f(5) + f(3) + f(1);
};
const hsvOf = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255),
    max = Math.max(r, g, b),
    d = max - Math.min(r, g, b);
  const h = d === 0 ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, max === 0 ? 0 : d / max, max];
};
/**
 * The colour picker, the one every colour in the app uses. `anchor` is a rectangle to open under. `color` is #RRGGBB or #RRGGBBAA.
 * `alpha: false` leaves out opacity; `none` adds a "Default" swatch that picks null. `onPick(color)` is told at the end of each change.
 */
function colorPicker(anchor, {color: current, alpha: withOpacity = true, none = false, onPick, dialog = null} = {}) {
  let [h, s, v] = hsvOf(current);
  let alpha = withOpacity && current.length === 9 ? parseInt(current.slice(7), 16) / 255 : 1;
  const withAlpha = rgb =>
    rgb +
    (alpha < 1
      ? Math.round(alpha * 255)
          .toString(16)
          .padStart(2, '0')
      : '');
  const menu = popup(anchor.left, anchor.bottom + 5, []);
  // Inside a modal dialog everything else is inert, so the picker goes into the dialog.
  if (dialog) {
    dialog.append(menu);
    menu.classList.add('in-dialog');
  }
  menu.classList.toggle('no-alpha', !withOpacity);
  menu.innerHTML = `<div class="color-picker"><div class="color-options">${SWATCHES.filter(color => color || none).map(color => `<button class="swatch" data-node-color="${color || ''}" style="${color ? `background:${color}` : ''}" title="${color || 'Default'}" aria-label="${color || 'Default color'}"></button>`).join('')}</div>
    <div class="sv" tabindex="0" aria-label="Saturation and brightness"><i class="sv-dot"></i></div>
    <input type="range" class="hue" min="0" max="360" step="1" aria-label="Hue">
    <label class="opacity-value"><span>Opacity</span><span class="opacity-percent"><input class="alpha-number" type="number" min="0" max="100" step="1" aria-label="Opacity percentage"><span>%</span></span></label>
    <input type="range" class="alpha" min="0" max="100" step="1" aria-label="Opacity">
    <div class="color-value"><span class="color-preview" aria-hidden="true"></span><input class="hex" maxlength="9" spellcheck="false" aria-label="Hex colour" placeholder="#RRGGBBAA"></div></div>`;
  const sv = $('.sv', menu),
    dot = $('.sv-dot', menu),
    hue = $('.hue', menu),
    opacity = $('.alpha', menu),
    percentage = $('.alpha-number', menu),
    hex = $('.hex', menu);
  const paint = () => {
    const rgb = hexOf(h, s, v);
    sv.style.background = `linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,${hexOf(h, 1, 1)})`;
    dot.style.left = s * 100 + '%';
    dot.style.top = (1 - v) * 100 + '%';
    hue.value = Math.round(h);
    hex.value = withAlpha(rgb);
    opacity.value = percentage.value = Math.round(alpha * 100);
    menu.style.setProperty('--alpha-color', rgb);
    menu.style.setProperty('--picked-color', hex.value);
    dot.style.background = rgb;
  };
  const commit = () => onPick(withAlpha(hexOf(h, s, v)));
  paint();
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(anchor.left, innerWidth - rect.width - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(anchor.bottom + 5, innerHeight - rect.height - 8)) + 'px';
  menu.addEventListener('click', e => {
    const swatch = e.target.closest('[data-node-color]');
    if (!swatch) return;
    onPick(swatch.dataset.nodeColor ? withAlpha(swatch.dataset.nodeColor) : null);
    closePopup();
  });
  sv.addEventListener('pointerdown', e => {
    sv.setPointerCapture(e.pointerId);
    const move = ev => {
      const r = sv.getBoundingClientRect();
      s = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
      v = 1 - Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height));
      paint();
    };
    const up = () => {
      sv.removeEventListener('pointermove', move);
      sv.removeEventListener('pointerup', up);
      commit();
    };
    sv.addEventListener('pointermove', move);
    sv.addEventListener('pointerup', up);
    move(e);
  });
  hue.addEventListener('input', () => {
    h = Number(hue.value);
    paint();
  });
  hue.addEventListener('change', commit);
  opacity.addEventListener('input', () => {
    alpha = Number(opacity.value) / 100;
    paint();
  });
  opacity.addEventListener('change', commit);
  percentage.addEventListener('change', () => {
    if (percentage.value.trim() === '' || !percentage.validity.valid) return paint();
    alpha = Number(percentage.value) / 100;
    paint();
    commit();
  });
  hex.addEventListener('change', () => {
    const value = hex.value.trim().startsWith('#') ? hex.value.trim() : '#' + hex.value.trim();
    if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) {
      [h, s, v] = hsvOf(value);
      alpha = withOpacity && value.length === 9 ? parseInt(value.slice(7), 16) / 255 : 1;
      paint();
      commit();
    } else paint();
  });
}

/** Every <input type=color> opens this picker instead of the browser's dialog; the input keeps its value and its events. */
document.addEventListener('click', event => {
  const input = event.target.closest?.('input[type=color]');
  if (!input) return;
  event.preventDefault();
  if (input.disabled) return;
  const rect = input.getBoundingClientRect();
  colorPicker(rect, {
    color: input.value || '#000000',
    alpha: false,
    dialog: input.closest('dialog'),
    onPick: color => {
      if (!color || color === input.value) return;
      input.value = color;
      input.dispatchEvent(new Event('input', {bubbles: true}));
      input.dispatchEvent(new Event('change', {bubbles: true}));
    },
  });
});
