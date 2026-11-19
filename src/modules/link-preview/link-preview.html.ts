export interface HeadTags {
  meta: Map<string, string>;
  title: string | null;
}

const MAX_ATTRIBUTES_PER_TAG = 32;
const RAW_TEXT_TAGS = new Set(['script', 'style', 'noscript', 'template', 'textarea']);

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\n' || char === '\t' || char === '\r' || char === '\f';
}

function findTagEnd(html: string, from: number): number {
  let quote: string | null = null;
  let previous = '';
  for (let index = from; index < html.length; index += 1) {
    const char = html.charAt(index);
    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if ((char === '"' || char === "'") && previous === '=') {
      quote = char;
      continue;
    }
    if (char === '>') {
      return index;
    }
    if (!isWhitespace(char)) {
      previous = char;
    }
  }
  return -1;
}

function findClosingTag(html: string, from: number, tagName: string): number {
  const needle = `</${tagName}`;
  let index = html.indexOf('<', from);
  while (index !== -1) {
    if (html.slice(index, index + needle.length).toLowerCase() === needle) {
      return index;
    }
    index = html.indexOf('<', index + 1);
  }
  return -1;
}

function readTagName(raw: string): { name: string; end: number } {
  let end = 0;
  while (end < raw.length) {
    const char = raw.charAt(end);
    if (isWhitespace(char) || char === '>' || (char === '/' && end > 0)) {
      break;
    }
    end += 1;
  }
  return { name: raw.slice(0, end).toLowerCase(), end };
}

export function parseAttributes(raw: string, from: number): Map<string, string> {
  const attributes = new Map<string, string>();
  let index = from;

  while (index < raw.length && attributes.size < MAX_ATTRIBUTES_PER_TAG) {
    while (index < raw.length && (isWhitespace(raw.charAt(index)) || raw.charAt(index) === '/')) {
      index += 1;
    }
    if (index >= raw.length) {
      break;
    }

    const nameStart = index;
    while (index < raw.length) {
      const char = raw.charAt(index);
      if (isWhitespace(char) || char === '=' || char === '/') {
        break;
      }
      index += 1;
    }
    const name = raw.slice(nameStart, index).toLowerCase();
    if (!name) {
      index += 1;
      continue;
    }

    while (index < raw.length && isWhitespace(raw.charAt(index))) {
      index += 1;
    }

    let value = '';
    if (raw.charAt(index) === '=') {
      index += 1;
      while (index < raw.length && isWhitespace(raw.charAt(index))) {
        index += 1;
      }
      const quote = raw.charAt(index);
      if (quote === '"' || quote === "'") {
        const closing = raw.indexOf(quote, index + 1);
        const valueEnd = closing === -1 ? raw.length : closing;
        value = raw.slice(index + 1, valueEnd);
        index = valueEnd + 1;
      } else {
        const valueStart = index;
        while (index < raw.length && !isWhitespace(raw.charAt(index))) {
          index += 1;
        }
        value = raw.slice(valueStart, index);
      }
    }

    if (!attributes.has(name)) {
      attributes.set(name, value);
    }
  }

  return attributes;
}

export function scanHeadTags(html: string): HeadTags {
  const meta = new Map<string, string>();
  let title: string | null = null;
  let index = 0;

  while (index < html.length) {
    const open = html.indexOf('<', index);
    if (open === -1) {
      break;
    }

    if (html.startsWith('<!--', open)) {
      const commentEnd = html.indexOf('-->', open + 4);
      if (commentEnd === -1) {
        break;
      }
      index = commentEnd + 3;
      continue;
    }

    const close = findTagEnd(html, open + 1);
    if (close === -1) {
      break;
    }

    const raw = html.slice(open + 1, close);
    index = close + 1;
    const { name, end } = readTagName(raw);

    if (name === 'body' || name === '/head') {
      break;
    }

    if (name === 'meta') {
      const attributes = parseAttributes(raw, end);
      const key = (attributes.get('property') ?? attributes.get('name'))?.trim().toLowerCase();
      const content = attributes.get('content');
      if (key && content !== undefined && !meta.has(key)) {
        meta.set(key, content);
      }
      continue;
    }

    if (name === 'title' || RAW_TEXT_TAGS.has(name)) {
      const closing = findClosingTag(html, index, name);
      if (closing === -1) {
        break;
      }
      if (name === 'title' && title === null) {
        title = html.slice(index, closing);
      }
      index = closing + name.length + 2;
    }
  }

  return { meta, title };
}
