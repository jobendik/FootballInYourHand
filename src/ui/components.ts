/**
 * Tiny DOM-building helpers so the menu screens stay declarative without a framework.
 */

export interface ElProps {
  class?: string;
  text?: string;
  html?: string;
  title?: string;
  onClick?: (e: MouseEvent) => void;
  dataset?: Record<string, string>;
  style?: Partial<CSSStyleDeclaration>;
  attrs?: Record<string, string>;
}

export type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.html !== undefined) node.innerHTML = props.html;
  if (props.title) node.title = props.title;
  if (props.onClick) node.addEventListener('click', props.onClick as EventListener);
  if (props.dataset) for (const [k, v] of Object.entries(props.dataset)) node.dataset[k] = v;
  if (props.style) Object.assign(node.style, props.style);
  if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) node.setAttribute(k, v);
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** A labelled button with a variant class. */
export function button(
  label: string,
  onClick: (e: MouseEvent) => void,
  variant: 'primary' | 'secondary' | 'ghost' | 'danger' = 'secondary',
  extraClass = '',
): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = `btn btn-${variant} ${extraClass}`.trim();
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

/** A coins/gems balance pill. */
export function currencyPill(icon: string, amount: number, cls = ''): HTMLElement {
  return h('div', { class: `currency-pill ${cls}`.trim() }, [
    h('span', { class: 'currency-icon', text: icon }),
    h('span', { class: 'currency-amount', text: formatNumber(amount) }),
  ]);
}

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 10_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return Math.round(n).toLocaleString('en-US');
}

/** Render a 0..5 (half-step) star rating as a row of glyphs. */
export function starRow(rating: number, cls = ''): HTMLElement {
  const row = h('div', { class: `star-row ${cls}`.trim() });
  for (let i = 1; i <= 5; i++) {
    let glyph = '☆';
    if (rating >= i) glyph = '★';
    else if (rating >= i - 0.5) glyph = '⯨'; // half (falls back to a thin star visually)
    row.append(h('span', { class: 'star', text: glyph }));
  }
  return row;
}

/** A simple labelled progress bar (0..1). */
export function progressBar(value: number, cls = ''): HTMLElement {
  return h('div', { class: `progress ${cls}`.trim() }, [
    h('div', { class: 'progress-fill', style: { width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` } }),
  ]);
}

/** Mount a transient toast message. */
export function toast(message: string, kind: 'info' | 'success' | 'error' = 'info'): void {
  const root = document.getElementById('ui-root') ?? document.body;
  const t = h('div', { class: `toast toast-${kind}`, text: message });
  root.append(t);
  // Trigger CSS transition.
  requestAnimationFrame(() => t.classList.add('toast-show'));
  setTimeout(() => {
    t.classList.remove('toast-show');
    setTimeout(() => t.remove(), 350);
  }, 2200);
}
