// Tiny, dependency-free, XSS-safe markdown renderer for assistant replies. HTML is escaped before
// markdown transforms run, so model output cannot inject markup.
function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
}

function renderInline(value) {
  return value
    .replace(/`([^`]+)`/g, (_match, code) => `<code>${code}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

export function renderMarkdown(src) {
  const blocks = [];
  let text = String(src ?? "").replace(/```(\w+)?\n?([\s\S]*?)```/g, (_match, _lang, code) => {
    const token = `%%CODE_BLOCK_${blocks.length}%%`;
    blocks.push(`<pre class="code"><code>${esc(code.replace(/\n$/, ""))}</code></pre>`);
    return token;
  });

  text = renderInline(esc(text));

  const out = [];
  let list = null;
  const closeList = () => {
    if (!list) return;
    out.push(`</${list}>`);
    list = null;
  };

  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const blockMatch = line.match(/^%%CODE_BLOCK_(\d+)%%$/);
    if (blockMatch) {
      closeList();
      out.push(blocks[Number(blockMatch[1])]);
      continue;
    }
    if (!line.trim()) {
      closeList();
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      closeList();
      out.push(`<h${heading[1].length}>${heading[2]}</h${heading[1].length}>`);
      continue;
    }
    const unordered = line.match(/^[-*]\s+(.*)$/);
    if (unordered) {
      if (list !== "ul") {
        closeList();
        out.push("<ul>");
        list = "ul";
      }
      out.push(`<li>${unordered[1]}</li>`);
      continue;
    }
    const ordered = line.match(/^\d+\.\s+(.*)$/);
    if (ordered) {
      if (list !== "ol") {
        closeList();
        out.push("<ol>");
        list = "ol";
      }
      out.push(`<li>${ordered[1]}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${line}</p>`);
  }
  closeList();
  return out.join("\n");
}
