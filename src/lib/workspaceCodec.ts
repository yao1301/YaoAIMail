type Encoded = { type: string; value?: unknown; name?: string; mime?: string; modified?: number };
// Most reports/history are ordinary JSON. Transfer them once, without allocating
// a Promise and a tagged envelope for every string, number and object property.
function isJsonTree(value: unknown, ancestors: Set<object>): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return false;
  ancestors.add(value);
  const valid = (Array.isArray(value) ? Array.from(value) : Object.values(value)).every(item => isJsonTree(item, ancestors));
  ancestors.delete(value);
  return valid;
}
export async function encodeWorkspaceValue(value: unknown, seen = new Set<object>()): Promise<Encoded> {
  if (value === undefined) return { type: 'undefined' };
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return { type: 'value', value };
  if (typeof value === 'number') return { type: 'number', value: String(value) };
  if (typeof value !== 'object') throw new Error('当前页面包含无法交接的状态，原标签已保留。');
  if (seen.has(value)) throw new Error('页面状态存在循环引用，原标签已保留。');
  if (isJsonTree(value, new Set(seen))) return { type: 'json', value };
  const next = new Set(seen).add(value);
  if (value instanceof File) return { type: 'file', name: value.name, mime: value.type, modified: value.lastModified, value: Array.from(new Uint8Array(await value.arrayBuffer())) };
  if (value instanceof Blob) return { type: 'blob', mime: value.type, value: Array.from(new Uint8Array(await value.arrayBuffer())) };
  if (value instanceof ArrayBuffer) return { type: 'buffer', value: Array.from(new Uint8Array(value)) };
  if (value instanceof Uint8Array) return { type: 'bytes', value: Array.from(value) };
  if (value instanceof Date) return { type: 'date', value: value.toISOString() };
  if (value instanceof Set) return { type: 'set', value: await Promise.all([...value].map(item => encodeWorkspaceValue(item, next))) };
  if (value instanceof Map) return { type: 'map', value: await Promise.all([...value].map(async ([key, item]) => [await encodeWorkspaceValue(key, next), await encodeWorkspaceValue(item, next)])) };
  if (Array.isArray(value)) return { type: 'array', value: await Promise.all(value.map(item => encodeWorkspaceValue(item, next))) };
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error('当前页面正在处理不可移动的对象，请稍后重试。');
  return { type: 'object', value: await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await encodeWorkspaceValue(item, next)])) };
}
export function decodeWorkspaceValue(encoded: Encoded): unknown {
  switch (encoded.type) {
    case 'json': return encoded.value;
    case 'undefined': return undefined;
    case 'value': return encoded.value;
    case 'number': return Number(encoded.value);
    case 'date': return new Date(encoded.value as string);
    case 'buffer': return new Uint8Array(encoded.value as number[]).buffer;
    case 'bytes': return new Uint8Array(encoded.value as number[]);
    case 'file': return new File([new Uint8Array(encoded.value as number[])], encoded.name ?? '', { type: encoded.mime, lastModified: encoded.modified });
    case 'blob': return new Blob([new Uint8Array(encoded.value as number[])], { type: encoded.mime });
    case 'array': return (encoded.value as Encoded[]).map(decodeWorkspaceValue);
    case 'set': return new Set((encoded.value as Encoded[]).map(decodeWorkspaceValue));
    case 'map': return new Map((encoded.value as [Encoded, Encoded][]).map(([key, value]) => [decodeWorkspaceValue(key), decodeWorkspaceValue(value)]));
    case 'object': return Object.fromEntries((encoded.value as [string, Encoded][]).map(([key, value]) => [key, decodeWorkspaceValue(value)]));
    default: throw new Error('独立窗口状态格式无效。');
  }
}
