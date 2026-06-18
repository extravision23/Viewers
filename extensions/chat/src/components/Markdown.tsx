import React from 'react';

function renderInline(text: string, keyBase: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > lastIndex) {
      nodes.push(text.slice(lastIndex, m.index));
    }
    const tok = m[0];
    if (tok.startsWith('**')) {
      nodes.push(<strong key={`${keyBase}-b${i}`}>{tok.slice(2, -2)}</strong>);
    } else {
      nodes.push(
        <code key={`${keyBase}-c${i}`} className="rounded bg-gray-700 px-1">
          {tok.slice(1, -1)}
        </code>
      );
    }
    lastIndex = m.index + tok.length;
    i++;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

const HR = /^(-{3,}|\*{3,}|_{3,})$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BOLD_LINE = /^\*\*[^*]+\*\*:?$/;
const BULLET = /^\s*[-*]\s+/;
const ORDERED = /^\s*\d+\.\s+/;

function Markdown({ text }: { text: string }) {
  const lines = (text || '').replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const trimmed = lines[i].trim();

    if (trimmed === '') {
      i++;
      continue;
    }
    if (HR.test(trimmed)) {
      blocks.push(<hr key={key++} className="my-2 border-gray-700" />);
      i++;
      continue;
    }
    const h = trimmed.match(HEADING);
    if (h) {
      blocks.push(
        <div key={key} className="mb-1 mt-2 font-semibold text-white">
          {renderInline(h[2], `h${key++}`)}
        </div>
      );
      i++;
      continue;
    }
    if (BOLD_LINE.test(trimmed)) {
      blocks.push(
        <div key={key} className="mb-1 mt-2 font-semibold text-white">
          {renderInline(trimmed, `h${key++}`)}
        </div>
      );
      i++;
      continue;
    }
    if (BULLET.test(lines[i])) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && BULLET.test(lines[i])) {
        const content = lines[i].replace(BULLET, '');
        items.push(<li key={items.length}>{renderInline(content, `li${key}-${items.length}`)}</li>);
        i++;
      }
      blocks.push(
        <ul key={key++} className="ml-4 list-disc space-y-0.5">
          {items}
        </ul>
      );
      continue;
    }
    if (ORDERED.test(lines[i])) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && ORDERED.test(lines[i])) {
        const content = lines[i].replace(ORDERED, '');
        items.push(<li key={items.length}>{renderInline(content, `ol${key}-${items.length}`)}</li>);
        i++;
      }
      blocks.push(
        <ol key={key++} className="ml-4 list-decimal space-y-0.5">
          {items}
        </ol>
      );
      continue;
    }

    // Paragraph: gather consecutive plain lines.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !HR.test(lines[i].trim()) &&
      !HEADING.test(lines[i].trim()) &&
      !BOLD_LINE.test(lines[i].trim()) &&
      !BULLET.test(lines[i]) &&
      !ORDERED.test(lines[i])
    ) {
      para.push(lines[i].trim());
      i++;
    }
    blocks.push(
      <p key={key} className="whitespace-pre-wrap">
        {para.map((pl, idx) => (
          <React.Fragment key={idx}>
            {idx > 0 && <br />}
            {renderInline(pl, `p${key}-${idx}`)}
          </React.Fragment>
        ))}
      </p>
    );
    key++;
  }

  return <div className="space-y-1 text-sm leading-relaxed">{blocks}</div>;
}

export default Markdown;
