/** @jsxImportSource preact */
import type { ComponentChildren } from 'preact';

/**
 * Markdown as Preact nodes, for issue bodies and comments.
 *
 * An issue can be imported from GitHub, so its text is another account's
 * input; building nodes rather than setting HTML leaves any markup in it as
 * text. The subset is what issues use: headings, paragraphs, lists with task
 * boxes, quotes, fenced code, rules, and inline code, bold, italic and links.
 * A link keeps its href only for http, https and mailto, so a `javascript:`
 * URL renders as plain text.
 */
export function Markdown({ text }: { text: string }) {
  return <div class="markdown">{blocksOf(text.replace(/\r\n?/g, '\n').split('\n'))}</div>;
}

function blocksOf(lines: string[]): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  let at = 0;
  while (at < lines.length) {
    const line = lines[at];
    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) {
      const body: string[] = [];
      at += 1;
      while (at < lines.length && !lines[at].trimStart().startsWith(fence[1])) body.push(lines[at++]);
      at += 1;
      out.push(<pre key={out.length}><code>{body.join('\n')}</code></pre>);
      continue;
    }
    if (!line.trim()) { at += 1; continue; }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const Tag = `h${Math.min(6, heading[1].length + 2)}` as 'h3';
      out.push(<Tag key={out.length}>{inline(heading[2])}</Tag>);
      at += 1;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push(<hr key={out.length} />); at += 1; continue; }
    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (at < lines.length && /^\s*>/.test(lines[at])) quoted.push(lines[at++].replace(/^\s*>\s?/, ''));
      out.push(<blockquote key={out.length}>{blocksOf(quoted)}</blockquote>);
      continue;
    }
    const listed = line.match(/^\s*([-*+]|\d+[.)])\s+/);
    if (listed) {
      const ordered = /\d/.test(listed[1]);
      const items: string[] = [];
      while (at < lines.length) {
        const item = lines[at].match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
        if (item && /\d/.test(item[1]) === ordered) { items.push(item[2]); at += 1; continue; }
        // An indented line continues the item above it.
        if (items.length && /^\s{2,}\S/.test(lines[at])) { items[items.length - 1] += ` ${lines[at].trim()}`; at += 1; continue; }
        break;
      }
      const rows = items.map((item, n) => {
        const task = item.match(/^\[([ xX])\]\s+(.*)$/);
        return task
          ? <li key={n} class="task"><input type="checkbox" checked={task[1] !== ' '} disabled />{inline(task[2])}</li>
          : <li key={n}>{inline(item)}</li>;
      });
      out.push(ordered ? <ol key={out.length}>{rows}</ol> : <ul key={out.length}>{rows}</ul>);
      continue;
    }
    const para: string[] = [];
    while (at < lines.length && lines[at].trim() && !/^(#{1,6}\s|\s*```|\s*~~~|\s*>|\s*([-*+]|\d+[.)])\s)/.test(lines[at])) {
      para.push(lines[at++].trim());
    }
    out.push(<p key={out.length}>{inline(para.join(' '))}</p>);
  }
  return out;
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\[[^\]]+\]\([^)\s]+\))|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

function inline(text: string): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const [whole, code, bold, link, italic, bare] = match;
    if (code) out.push(<code key={at}>{code.slice(1, -1)}</code>);
    else if (bold) out.push(<strong key={at}>{inline(bold.slice(2, -2))}</strong>);
    else if (italic) out.push(<em key={at}>{inline(italic.slice(1, -1))}</em>);
    else if (link) {
      const [, label, href] = link.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)!;
      out.push(safeHref(href)
        ? <a key={at} href={href} target="_blank" rel="noopener noreferrer">{inline(label)}</a>
        : whole);
    } else if (bare) out.push(<a key={at} href={bare} target="_blank" rel="noopener noreferrer">{bare}</a>);
    last = at + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function safeHref(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href);
}
