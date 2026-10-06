// PDF の関数(Function)の評価。グラデーション(Shading)と特色(Separation / DeviceN)の色を、CMYK に変換するときに使う。
// 対応: 0(標本)・2(指数)・3(つなぎ合わせ)・4(PostScript の計算式)
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, type PDFDocument, type PDFObject } from '@cantoo/pdf-lib';
import { streamBytes } from '../print/structure.ts';

/** 入力(定義域の値)→ 出力(値域の値) */
export type PdfFunction = (input: readonly number[]) => number[];

function resolve(doc: PDFDocument, o: PDFObject | undefined): PDFObject | undefined {
  return o instanceof PDFRef ? doc.context.lookup(o) : o;
}

function numbers(doc: PDFDocument, o: PDFObject | undefined): number[] | undefined {
  const v = resolve(doc, o);
  if (!(v instanceof PDFArray)) return undefined;
  return v.asArray().map((x) => {
    const n = resolve(doc, x);
    return n instanceof PDFNumber ? n.asNumber() : 0;
  });
}

const clip = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const interpolate = (x: number, x0: number, x1: number, y0: number, y1: number) => (x1 === x0 ? y0 : y0 + ((x - x0) * (y1 - y0)) / (x1 - x0));

/** 関数を読み込む。読めない・未対応なら undefined */
export function loadFunction(doc: PDFDocument, obj: PDFObject | undefined, depth = 0): PdfFunction | undefined {
  const v = resolve(doc, obj);
  if (depth > 8) return undefined;
  // 関数の配列(出力 1 つの関数を、出力の数だけ並べたもの)
  if (v instanceof PDFArray) {
    const fns = v.asArray().map((f) => loadFunction(doc, f, depth + 1));
    if (fns.some((f) => !f)) return undefined;
    return (input) => fns.flatMap((f) => f!(input).slice(0, 1));
  }
  const dict = v instanceof PDFStream ? v.dict : v instanceof PDFDict ? v : undefined;
  if (!dict) return undefined;
  const num = (key: string) => {
    const x = resolve(doc, dict.get(PDFName.of(key)));
    return x instanceof PDFNumber ? x.asNumber() : undefined;
  };
  const functionType = num('FunctionType');
  const domain = numbers(doc, dict.get(PDFName.of('Domain'))) ?? [0, 1];
  const range = numbers(doc, dict.get(PDFName.of('Range')));
  const clipDomain = (input: readonly number[]) => input.map((x, i) => clip(x, domain[2 * i] ?? 0, domain[2 * i + 1] ?? 1));
  const clipRange = (out: number[]) => (range ? out.map((y, j) => clip(y, range[2 * j], range[2 * j + 1])) : out);

  switch (functionType) {
    case 0: {
      if (!(v instanceof PDFStream) || !range) return undefined;
      const size = numbers(doc, dict.get(PDFName.of('Size')));
      const bps = num('BitsPerSample') ?? 8;
      if (!size || ![1, 2, 4, 8, 12, 16, 24, 32].includes(bps)) return undefined;
      const m = size.length;
      const n = range.length / 2;
      const encode = numbers(doc, dict.get(PDFName.of('Encode'))) ?? size.flatMap((s) => [0, s - 1]);
      const decode = numbers(doc, dict.get(PDFName.of('Decode'))) ?? range;
      let data: Uint8Array;
      try {
        data = streamBytes(v);
      } catch {
        return undefined;
      }
      const max = 2 ** bps - 1;
      const sampleAt = (index: number): number => {
        // index 番目の標本(ビット単位で読む)
        const bit = index * bps;
        let value = 0;
        for (let k = 0; k < bps; k++) {
          const b = bit + k;
          value = value * 2 + ((data[b >> 3] >> (7 - (b & 7))) & 1);
        }
        return value;
      };
      const sampleVector = (coords: readonly number[]): number[] => {
        let offset = 0;
        let stride = 1;
        for (let i = 0; i < m; i++) {
          offset += coords[i] * stride;
          stride *= size[i];
        }
        return Array.from({ length: n }, (_, j) => sampleAt(offset * n + j));
      };
      return (input) => {
        const x = clipDomain(input);
        const e = x.map((xi, i) => clip(interpolate(xi, domain[2 * i], domain[2 * i + 1], encode[2 * i], encode[2 * i + 1]), 0, size[i] - 1));
        // 多重線形補間: 2^m 個の角の標本を重みづけして足す
        const out = new Array<number>(n).fill(0);
        for (let corner = 0; corner < 1 << m; corner++) {
          let weight = 1;
          const coords: number[] = [];
          for (let i = 0; i < m; i++) {
            const lo = Math.min(Math.floor(e[i]), size[i] - 1);
            const hi = Math.min(lo + 1, size[i] - 1);
            const t = e[i] - lo;
            const useHi = (corner >> i) & 1;
            weight *= useHi ? t : 1 - t;
            coords.push(useHi ? hi : lo);
          }
          if (weight === 0) continue;
          const s = sampleVector(coords);
          for (let j = 0; j < n; j++) out[j] += weight * s[j];
        }
        return clipRange(out.map((sj, j) => interpolate(sj, 0, max, decode[2 * j], decode[2 * j + 1])));
      };
    }
    case 2: {
      const c0 = numbers(doc, dict.get(PDFName.of('C0'))) ?? [0];
      const c1 = numbers(doc, dict.get(PDFName.of('C1'))) ?? [1];
      const exponent = num('N') ?? 1;
      return (input) => {
        const [x] = clipDomain(input);
        const p = x ** exponent;
        return clipRange(c0.map((a, j) => a + p * ((c1[j] ?? a) - a)));
      };
    }
    case 3: {
      const fnsObj = resolve(doc, dict.get(PDFName.of('Functions')));
      if (!(fnsObj instanceof PDFArray)) return undefined;
      const fns = fnsObj.asArray().map((f) => loadFunction(doc, f, depth + 1));
      if (fns.some((f) => !f)) return undefined;
      const bounds = numbers(doc, dict.get(PDFName.of('Bounds'))) ?? [];
      const encode = numbers(doc, dict.get(PDFName.of('Encode'))) ?? fns.flatMap(() => [0, 1]);
      return (input) => {
        const [x] = clipDomain(input);
        let i = 0;
        while (i < bounds.length && x >= bounds[i]) i++;
        const lo = i === 0 ? domain[0] : bounds[i - 1];
        const hi = i === bounds.length ? domain[1] : bounds[i];
        return clipRange(fns[i]!([interpolate(x, lo, hi, encode[2 * i], encode[2 * i + 1])]));
      };
    }
    case 4: {
      if (!(v instanceof PDFStream) || !range) return undefined;
      let program: PsProc;
      try {
        program = parsePostScript(new TextDecoder('latin1').decode(streamBytes(v)));
      } catch {
        return undefined;
      }
      return (input) => {
        const stack = [...clipDomain(input)];
        runPostScript(program, stack);
        return clipRange(stack.slice(-range.length / 2).map((x) => (typeof x === 'number' ? x : x ? 1 : 0)));
      };
    }
    default:
      return undefined;
  }
}

// ---------- PostScript の計算式(関数の型 4) ----------

type PsItem = number | string | PsProc;
interface PsProc {
  readonly items: PsItem[];
}

function parsePostScript(text: string): PsProc {
  const tokens = text.match(/[{}]|[^\s{}]+/g) ?? [];
  let pos = 0;
  const parse = (): PsProc => {
    const items: PsItem[] = [];
    while (pos < tokens.length) {
      const t = tokens[pos++];
      if (t === '{') items.push(parse());
      else if (t === '}') return { items };
      else if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) items.push(Number(t));
      else items.push(t);
    }
    return { items };
  };
  // 全体は { ... } で囲まれている
  const top = parse();
  const first = top.items[0];
  return typeof first === 'object' ? first : top;
}

function runPostScript(proc: PsProc, stack: (number | boolean)[]): void {
  const pop = () => {
    const v = stack.pop();
    if (v === undefined) throw new Error('stack underflow');
    return v;
  };
  const popNum = () => Number(pop());
  const items = proc.items;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (typeof it === 'number') {
      stack.push(it);
      continue;
    }
    if (typeof it === 'object') {
      // if / ifelse の手続き。直後の演算子で使う
      const next = items[i + 1];
      if (next === 'if') {
        if (pop()) runPostScript(it, stack);
        i++;
      } else if (typeof next === 'object' && items[i + 2] === 'ifelse') {
        runPostScript(pop() ? it : next, stack);
        i += 2;
      }
      continue;
    }
    switch (it) {
      case 'add': stack.push(popNum() + popNum()); break;
      case 'sub': { const b = popNum(); stack.push(popNum() - b); break; }
      case 'mul': stack.push(popNum() * popNum()); break;
      case 'div': { const b = popNum(); stack.push(popNum() / b); break; }
      case 'idiv': { const b = popNum(); stack.push(Math.trunc(popNum() / b)); break; }
      case 'mod': { const b = popNum(); stack.push(popNum() % b); break; }
      case 'neg': stack.push(-popNum()); break;
      case 'abs': stack.push(Math.abs(popNum())); break;
      case 'ceiling': stack.push(Math.ceil(popNum())); break;
      case 'floor': stack.push(Math.floor(popNum())); break;
      case 'round': stack.push(Math.round(popNum())); break;
      case 'truncate': stack.push(Math.trunc(popNum())); break;
      case 'sqrt': stack.push(Math.sqrt(popNum())); break;
      case 'sin': stack.push(Math.sin((popNum() * Math.PI) / 180)); break;
      case 'cos': stack.push(Math.cos((popNum() * Math.PI) / 180)); break;
      case 'atan': { const b = popNum(); const a = popNum(); stack.push(((Math.atan2(a, b) * 180) / Math.PI + 360) % 360); break; }
      case 'exp': { const b = popNum(); stack.push(popNum() ** b); break; }
      case 'ln': stack.push(Math.log(popNum())); break;
      case 'log': stack.push(Math.log10(popNum())); break;
      case 'cvi': stack.push(Math.trunc(popNum())); break;
      case 'cvr': stack.push(popNum()); break;
      case 'dup': { const a = pop(); stack.push(a, a); break; }
      case 'pop': pop(); break;
      case 'exch': { const b = pop(); const a = pop(); stack.push(b, a); break; }
      case 'copy': { const n = popNum(); stack.push(...stack.slice(stack.length - n)); break; }
      case 'index': { const n = popNum(); stack.push(stack[stack.length - 1 - n]); break; }
      case 'roll': {
        const j = popNum();
        const n = popNum();
        if (n > 0) {
          const part = stack.splice(stack.length - n, n);
          const k = ((j % n) + n) % n;
          stack.push(...part.slice(n - k), ...part.slice(0, n - k));
        }
        break;
      }
      case 'eq': stack.push(pop() === pop()); break;
      case 'ne': stack.push(pop() !== pop()); break;
      case 'gt': { const b = popNum(); stack.push(popNum() > b); break; }
      case 'ge': { const b = popNum(); stack.push(popNum() >= b); break; }
      case 'lt': { const b = popNum(); stack.push(popNum() < b); break; }
      case 'le': { const b = popNum(); stack.push(popNum() <= b); break; }
      case 'and': { const b = pop(); const a = pop(); stack.push(typeof a === 'boolean' ? a && (b as boolean) : (a as number) & (b as number)); break; }
      case 'or': { const b = pop(); const a = pop(); stack.push(typeof a === 'boolean' ? a || (b as boolean) : (a as number) | (b as number)); break; }
      case 'xor': { const b = pop(); const a = pop(); stack.push(typeof a === 'boolean' ? a !== b : (a as number) ^ (b as number)); break; }
      case 'not': { const a = pop(); stack.push(typeof a === 'boolean' ? !a : ~(a as number)); break; }
      case 'bitshift': { const s = popNum(); const a = popNum(); stack.push(s >= 0 ? a << s : a >> -s); break; }
      case 'true': stack.push(true); break;
      case 'false': stack.push(false); break;
      default:
        throw new Error(`unsupported operator: ${it}`);
    }
  }
}
