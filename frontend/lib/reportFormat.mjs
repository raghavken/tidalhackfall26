// Turn Nemotron's free-text answer into report blocks: headings (lines ending
// in ":" or markdown "#"/"**Heading**"), bullet / numbered lists, paragraphs.
// Pure, so it's unit-tested; VerdictPanel renders the blocks.

/** Split "**bold**" spans: returns [{text, bold}] segments. */
export function inlineSegments(text) {
  return text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map(part =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4
      ? { text: part.slice(2, -2), bold: true } : { text: part, bold: false });
}

/** -> [{type:'h', text} | {type:'p', text} | {type:'list', ordered, items:[text]}] */
export function parseReport(text) {
  const blocks = [];
  let list = null;
  let para = [];
  const flushPara = () => { if (para.length) { blocks.push({ type: 'p', text: para.join(' ') }); para = []; } };
  const flushList = () => { if (list) { blocks.push(list); list = null; } };
  for (const raw of String(text ?? '').replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (!line) { flushPara(); flushList(); continue; }
    const md = line.match(/^#{1,6}\s+(.*)$/) || line.match(/^\*\*([^*]{2,60})\*\*:?$/);
    const colon = !md && line.length <= 60 && /:$/.test(line) && !/^([-*•]|\d+[.)])\s/.test(line);
    const bullet = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (md || colon) {
      flushPara();
      flushList();
      blocks.push({ type: 'h', text: (md ? md[1] : line).replace(/:$/, '').trim() });
    } else if (bullet) {
      flushPara();
      const ordered = /^\d/.test(line);
      if (!list || list.ordered !== ordered) { flushList(); list = { type: 'list', ordered, items: [] }; }
      list.items.push(bullet[1]);
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return blocks;
}
