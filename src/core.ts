/**
 * Core filter/function library for @tugrul/twig-runtime.
 *
 * The kernel ships only the execution machinery plus the `escape` filter
 * (derived from the escaper). Everything else is OPT-IN through this
 * module - imported from the `@tugrul/twig-runtime/core` subpath so
 * bundlers can tree-shake it away entirely when unused:
 *
 *   import { getRuntime } from '@tugrul/twig-runtime';
 *   import { registerCore } from '@tugrul/twig-runtime/core';
 *
 *   const runtime = registerCore(getRuntime(options));
 *   // or cherry-pick:
 *   // runtime.registerFilters({ upper: coreFilters.upper });
 *
 * Semantics are JavaScript-native, matching the transpiler's pure-JS
 * output philosophy.
 */

import { TwigRuntime, TwigFilter, TwigFunction, TwigMarkup, markup } from './index.js';

const values = (v: unknown): unknown[] =>
  Array.isArray(v) ? v : Object.values((v as object) ?? {});

const str = (v: unknown): string =>
  v instanceof TwigMarkup ? v.content : String(v ?? '');

export const coreFilters: Record<string, TwigFilter> = {
  async upper(v) { return str(v).toUpperCase(); },
  async lower(v) { return str(v).toLowerCase(); },
  async title(v) {
    return str(v).replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
  },
  async capitalize(v) {
    const s = str(v);
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  },
  async trim(v, chars?: string) {
    if (chars === undefined) return str(v).trim();
    const cls = `[${chars.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}]`;
    return str(v)
      .replace(new RegExp(`^${cls}+`), '')
      .replace(new RegExp(`${cls}+$`), '');
  },
  async nl2br(v) {
    return markup(str(v).replace(/\n/g, '<br />\n'));
  },
  async striptags(v) { return str(v).replace(/<[^>]*>/g, ''); },
  async abs(v) { return Math.abs(v as number); },
  async round(v, precision = 0, method: 'common' | 'floor' | 'ceil' = 'common') {
    const factor = 10 ** (precision as number);
    const scaled = (v as number) * factor;
    const rounded =
      method === 'floor' ? Math.floor(scaled) :
      method === 'ceil' ? Math.ceil(scaled) : Math.round(scaled);
    return rounded / factor;
  },
  async length(v) {
    if (typeof v === 'string' || Array.isArray(v)) return v.length;
    if (v instanceof TwigMarkup) return v.content.length;
    return Object.keys((v as object) ?? {}).length;
  },
  async first(v) { return typeof v === 'string' ? v[0] : values(v)[0]; },
  async last(v) {
    const a = typeof v === 'string' ? v : values(v);
    return a[a.length - 1];
  },
  async keys(v) { return Object.keys((v as object) ?? {}); },
  async join(v, glue = '', and: string | null = null) {
    const parts = values(v).map(str);
    if (and === null || parts.length < 2) return parts.join(glue as string);
    return parts.slice(0, -1).join(glue as string) + and + parts[parts.length - 1];
  },
  async split(v, delimiter: string, limit?: number) {
    const parts = str(v).split(delimiter);
    if (limit === undefined || parts.length <= limit) return parts;
    return [...parts.slice(0, limit - 1), parts.slice(limit - 1).join(delimiter)];
  },
  async replace(v, map: Record<string, unknown>) {
    let s = str(v);
    for (const [from, to] of Object.entries(map)) s = s.split(from).join(str(to));
    return s;
  },
  async slice(v, start: number, length: number | null = null) {
    const sliceable = typeof v === 'string' ? v : values(v);
    if (length === null) return sliceable.slice(start);
    return sliceable.slice(start, start < 0 ? undefined : start + length);
  },
  async reverse(v) {
    return typeof v === 'string' ? [...v].reverse().join('') : [...values(v)].reverse();
  },
  async sort(v, comparator?: (a: unknown, b: unknown) => Promise<number>) {
    const a = [...values(v)];
    if (!comparator) {
      return a.sort((x, y) => ((x as never) < (y as never) ? -1 : (x as never) > (y as never) ? 1 : 0));
    }
    for (let i = 1; i < a.length; i++) {
      let j = i;
      while (j > 0 && (await comparator(a[j - 1], a[j])) > 0) {
        [a[j - 1], a[j]] = [a[j], a[j - 1]];
        j--;
      }
    }
    return a;
  },
  async merge(a, b) {
    return Array.isArray(a) && Array.isArray(b)
      ? [...a, ...b]
      : { ...(a as object), ...(b as object) };
  },
  async default(v, fallback = '') {
    return v === undefined || v === null || v === '' || v === false ? fallback : v;
  },
  async json_encode(v) { return JSON.stringify(v instanceof TwigMarkup ? v.content : v); },
  async filter(v, fn: (item: unknown, key?: unknown) => Promise<unknown>) {
    const arr = values(v);
    const keep = await Promise.all(arr.map((item, i) => fn(item, i)));
    return arr.filter((_, i) => keep[i]);
  },
  async map(v, fn: (item: unknown, key?: unknown) => Promise<unknown>) {
    return Promise.all(values(v).map((item, i) => fn(item, i)));
  },
  async reduce(v, fn: (carry: unknown, item: unknown) => Promise<unknown>, initial: unknown = null) {
    let carry = initial;
    for (const item of values(v)) carry = await fn(carry, item);
    return carry;
  },
};

export const coreFunctions: Record<string, TwigFunction> = {
  async range(low: number | string, high: number | string, step = 1) {
    const out: Array<number | string> = [];
    if (typeof low === 'string') {
      const a = low.charCodeAt(0);
      const b = (high as string).charCodeAt(0);
      for (let c = a; a <= b ? c <= b : c >= b; c += a <= b ? step : -step) {
        out.push(String.fromCharCode(c));
      }
      return out;
    }
    const hi = high as number;
    for (let v = low; low <= hi ? v <= hi : v >= hi; v += low <= hi ? step : -step) {
      out.push(v);
    }
    return out;
  },
  async max(...vals: unknown[]) {
    const a = vals.length === 1 && typeof vals[0] === 'object' ? values(vals[0]) : vals;
    return a.reduce((x, y) => ((x as never) >= (y as never) ? x : y));
  },
  async min(...vals: unknown[]) {
    const a = vals.length === 1 && typeof vals[0] === 'object' ? values(vals[0]) : vals;
    return a.reduce((x, y) => ((x as never) <= (y as never) ? x : y));
  },
  async cycle(vals: unknown, position: number) {
    const a = values(vals);
    return a[position % a.length];
  },
  async has_some(v: unknown, fn: (item: unknown) => Promise<unknown>) {
    for (const item of values(v)) if (await fn(item)) return true;
    return false;
  },
  async has_every(v: unknown, fn: (item: unknown) => Promise<unknown>) {
    for (const item of values(v)) if (!(await fn(item))) return false;
    return true;
  },
};

/** Register the whole core library into a runtime (chainable). */
export function registerCore(runtime: TwigRuntime): TwigRuntime {
  runtime.registerFilters(coreFilters);
  runtime.registerFunctions(coreFunctions);
  return runtime;
}
