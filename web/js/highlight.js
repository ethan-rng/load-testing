// A tiny syntax highlighter: enough to make source readable, no dependencies.
// Returns lines of {cls, text} tokens, built as DOM nodes by the caller.

const JS = {
  re: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\[\s\S])*`)|\b(\d[\d_]*(?:\.\d+)?)\b|\b(import|export|from|const|let|var|function|return|if|else|for|while|of|in|new|class|extends|async|await|try|catch|finally|throw|type|interface|as|default|typeof|satisfies|null|undefined|true|false|void|this|switch|case|break|continue)\b/g,
  classes: ["comment", "string", "number", "keyword"],
};
const JSON_ = { re: /("(?:[^"\\\n]|\\.)*")(\s*:)?|\b(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b|\b(true|false|null)\b/g, classes: ["string", "key", "number", "keyword"] };
const SH = {
  re: /(#[^\n]*)|("(?:[^"\\]|\\.)*"|'[^']*')|\b(\d+)\b|\b(if|then|else|fi|for|do|done|case|esac|in|set|cd|export|echo|exit|mkdir|while|local)\b/g,
  classes: ["comment", "string", "number", "keyword"],
};
const CSS = { re: /(\/\*[\s\S]*?\*\/)|("[^"\n]*"|'[^'\n]*')|(#[0-9a-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|rem|em|%|s|ms|vh|vw)?\b)|(--[\w-]+)/g, classes: ["comment", "string", "number", "keyword"] };

const LANGS = { ts: JS, js: JS, mjs: JS, json: JSON_, sh: SH, css: CSS };

export function highlight(code, language) {
  const lang = LANGS[language];
  const tokens = [];
  if (!lang) tokens.push({ cls: "", text: code });
  else {
    let last = 0;
    lang.re.lastIndex = 0;
    for (let m; (m = lang.re.exec(code)); ) {
      if (m[0] === "") { lang.re.lastIndex++; continue; }
      if (m.index > last) tokens.push({ cls: "", text: code.slice(last, m.index) });
      let cls = "";
      for (let i = 0; i < lang.classes.length; i++) if (m[i + 1] !== undefined) { cls = lang.classes[i]; break; }
      if (lang === JSON_ && m[2]) { // "key": split off the colon
        tokens.push({ cls: "key", text: m[1] }, { cls: "", text: m[2] });
      } else tokens.push({ cls, text: m[0] });
      last = m.index + m[0].length;
    }
    if (last < code.length) tokens.push({ cls: "", text: code.slice(last) });
  }
  // split into lines so each can be numbered
  const lines = [[]];
  for (const t of tokens) {
    const parts = t.text.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ cls: t.cls, text: part });
    });
  }
  if (lines.length > 1 && lines[lines.length - 1].length === 0) lines.pop(); // trailing newline
  return lines;
}
