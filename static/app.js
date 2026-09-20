const messagesDiv = document.getElementById("messages");
const messageInput = document.getElementById("messageInput");
const sendButton = document.getElementById("sendButton");

let history = [];
let pageContext = null;

// Math is rendered to HTML BEFORE Markdown runs, and put back into the
// DOM AFTER sanitising. Rendering it afterwards does not work: with
// `breaks: true`, marked turns the newlines around a display block into
// <br> tags, so "$$", the formula and the closing "$$" end up in three
// separate text nodes and KaTeX's auto-render (which only scans within a
// single text node) never sees a complete delimiter pair.

const MATH_PLACEHOLDER_PREFIX = "@@KMATH";
const MATH_PLACEHOLDER_SUFFIX = "@@";

// $$...$$ and \[...\] are display; $...$ and \(...\) are inline.
const MATH_PATTERN = new RegExp(
  [
    "\\$\\$([\\s\\S]+?)\\$\\$",
    "\\\\\\[([\\s\\S]+?)\\\\\\]",
    "\\$((?:[^$\\\\\\n]|\\\\.)+?)\\$",
    "\\\\\\(([\\s\\S]+?)\\\\\\)"
  ].join("|"),
  "g"
);

function renderTex(tex, displayMode) {
  try {
    return katex.renderToString(tex.trim(), {
      displayMode: displayMode,
      throwOnError: false,
      output: "html"
    });
  } catch (error) {
    console.error("KaTeX failed on:", tex, error);
    return null;
  }
}

// Replaces every math span with an opaque placeholder and returns the
// already-rendered HTML for each one. Code spans and fenced blocks are
// left untouched.
function extractMath(text) {
  const segments = text.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  const rendered = [];

  const processed = segments.map(function (segment, index) {
    if (index % 2 === 1) return segment;

    return segment.replace(
      MATH_PATTERN,
      function (match, display$, displayBracket, inline$, inlineParen) {
        const isDisplay =
          display$ !== undefined || displayBracket !== undefined;

        const tex =
          display$ !== undefined ? display$
          : displayBracket !== undefined ? displayBracket
          : inline$ !== undefined ? inline$
          : inlineParen;

        const html = renderTex(tex, isDisplay);

        // On failure, leave the original text in place.
        if (html === null) return match;

        rendered.push({ html: html, display: isDisplay });

        return (
          MATH_PLACEHOLDER_PREFIX +
          (rendered.length - 1) +
          MATH_PLACEHOLDER_SUFFIX
        );
      }
    );
  });

  return { text: processed.join(""), math: rendered };
}

// Swaps the placeholders in the sanitised DOM back for the KaTeX output.
// The KaTeX HTML is generated locally, so it never passes through the
// sanitiser (which would strip the markup KaTeX needs).
function restoreMath(root, math) {
  if (math.length === 0) return;

  const pattern = new RegExp(
    MATH_PLACEHOLDER_PREFIX + "(\\d+)" + MATH_PLACEHOLDER_SUFFIX,
    "g"
  );

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets = [];

  while (walker.nextNode()) {
    pattern.lastIndex = 0;
    if (pattern.test(walker.currentNode.nodeValue)) {
      targets.push(walker.currentNode);
    }
  }

  targets.forEach(function (node) {
    const holder = document.createElement("span");

    holder.innerHTML = node.nodeValue.replace(
      pattern,
      function (match, index) {
        const entry = math[Number(index)];
        return entry ? entry.html : match;
      }
    );

    // A display formula that is the only thing in its paragraph replaces
    // the paragraph, so the block-level KaTeX output is not nested in a <p>.
    const parent = node.parentNode;

    if (
      parent &&
      parent.tagName === "P" &&
      parent.childNodes.length === 1 &&
      holder.childElementCount === 1 &&
      holder.textContent.trim() === holder.firstElementChild.textContent.trim()
    ) {
      parent.parentNode.replaceChild(holder.firstElementChild, parent);
      return;
    }

    while (holder.firstChild) {
      parent.insertBefore(holder.firstChild, node);
    }

    parent.removeChild(node);
  });
}

// ----------------------------------------------------------------------
// Figures
//
// The model cannot draw, so it must never try to with text art. Instead it
// emits a fenced ```fplot block holding JSON, and this page draws a real
// F-density curve with the right tail shaded. The SVG is built here, from
// the numbers in the block, so nothing drawable comes from the model.
// ----------------------------------------------------------------------

// Lanczos approximation, good to about 15 digits over the range we need.
function logGamma(z) {
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7
  ];
  if (z < 0.5) {
    return (
      Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z)
    );
  }
  z -= 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < g.length; i++) x += g[i] / (z + i + 1);
  const t = z + g.length - 0.5;
  return (
    0.5 * Math.log(2 * Math.PI) +
    (z + 0.5) * Math.log(t) - t + Math.log(x)
  );
}

function fDensity(x, df1, df2) {
  if (x <= 0) return 0;
  const logBeta =
    logGamma(df1 / 2) + logGamma(df2 / 2) - logGamma((df1 + df2) / 2);
  const logPdf =
    (df1 / 2) * Math.log(df1 / df2) +
    (df1 / 2 - 1) * Math.log(x) -
    ((df1 + df2) / 2) * Math.log(1 + (df1 * x) / df2) -
    logBeta;
  return Math.exp(logPdf);
}

function svgEl(name, attrs) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", name);
  Object.keys(attrs || {}).forEach(k => el.setAttribute(k, attrs[k]));
  return el;
}

// spec: {df1, df2, f_star, caption, x_label, shade_label}
function buildFPlot(spec) {
  const df1 = Number(spec.df1) > 0 ? Number(spec.df1) : 4;
  const df2 = Number(spec.df2) > 0 ? Number(spec.df2) : 20;
  const hasF = Number.isFinite(Number(spec.f_star));
  const fStar = hasF ? Number(spec.f_star) : null;

  const W = 440, H = 258;
  const m = { l: 44, r: 14, t: 16, b: 52 };
  const plotW = W - m.l - m.r;
  const plotH = H - m.t - m.b;

  // Show the whole shape, and always a little past F*.
  const xMax = Math.max(5, hasF ? fStar * 1.6 : 5);
  const n = 240;
  const xs = [], ys = [];
  for (let i = 0; i <= n; i++) {
    const x = (i / n) * xMax;
    xs.push(x);
    ys.push(fDensity(x === 0 ? 1e-6 : x, df1, df2));
  }
  const yMax = Math.max(...ys) * 1.12 || 1;

  const px = x => m.l + (x / xMax) * plotW;
  const py = y => m.t + plotH - (y / yMax) * plotH;

  const svg = svgEl("svg", {
    viewBox: `0 0 ${W} ${H}`,
    width: "100%",
    role: "img",
    class: "agent-figure-svg",
    "aria-label":
      spec.caption ||
      `F(${df1}, ${df2}) density with the right tail shaded`
  });

  // Shaded right tail.
  if (hasF && fStar < xMax) {
    let d = `M ${px(fStar)} ${py(0)}`;
    xs.forEach((x, i) => {
      if (x >= fStar) d += ` L ${px(x)} ${py(ys[i])}`;
    });
    d += ` L ${px(xMax)} ${py(0)} Z`;
    svg.appendChild(svgEl("path", { d, fill: "rgba(81,36,122,0.30)" }));
  }

  // Axes.
  svg.appendChild(svgEl("line", {
    x1: m.l, y1: py(0), x2: m.l + plotW, y2: py(0),
    stroke: "#2F3437", "stroke-width": 1.2
  }));
  svg.appendChild(svgEl("line", {
    x1: m.l, y1: m.t, x2: m.l, y2: py(0),
    stroke: "#2F3437", "stroke-width": 1.2
  }));

  // X axis ticks, at a round step covering the range shown.
  const rawStep = xMax / 5;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const step = [1, 2, 2.5, 5, 10].map(s => s * mag)
    .find(s => xMax / s <= 6) || rawStep;
  for (let t = 0; t <= xMax + 1e-9; t += step) {
    svg.appendChild(svgEl("line", {
      x1: px(t), y1: py(0), x2: px(t), y2: py(0) + 4,
      stroke: "#2F3437", "stroke-width": 1
    }));
    const lab = svgEl("text", {
      x: px(t), y: py(0) + 15,
      "text-anchor": "middle", "font-size": 11, fill: "#5c5c5c"
    });
    lab.textContent = String(Number(t.toFixed(2)));
    svg.appendChild(lab);
  }

  // Density curve.
  svg.appendChild(svgEl("path", {
    d: xs.map((x, i) => `${i ? "L" : "M"} ${px(x)} ${py(ys[i])}`).join(" "),
    fill: "none", stroke: "#2F3437", "stroke-width": 2
  }));

  // F* marker.
  if (hasF && fStar < xMax) {
    svg.appendChild(svgEl("line", {
      x1: px(fStar), y1: py(0), x2: px(fStar), y2: py(fDensity(fStar, df1, df2)),
      stroke: "#51247A", "stroke-width": 2, "stroke-dasharray": "5 4"
    }));
    const tick = svgEl("text", {
      x: px(fStar), y: m.t + plotH + 28,
      "text-anchor": "middle", "font-size": 12, fill: "#51247A",
      "font-weight": "600"
    });
    tick.textContent = spec.f_label || `F* = ${fStar}`;
    svg.appendChild(tick);

    // The tail is thin, so the label sits above it with a leader line
    // pointing into the shaded area.
    const midX = px(fStar + (xMax - fStar) * 0.35);
    const labelY = Math.max(m.t + 14, py(0) - 64);
    svg.appendChild(svgEl("line", {
      x1: midX, y1: labelY + 5, x2: midX, y2: py(0) - 6,
      stroke: "#51247A", "stroke-width": 1
    }));
    const shade = svgEl("text", {
      x: midX, y: labelY,
      "text-anchor": "middle", "font-size": 12, fill: "#51247A"
    });
    shade.textContent = spec.shade_label || "p-value";
    svg.appendChild(shade);
  }

  // Axis labels.
  const xLab = svgEl("text", {
    x: m.l + plotW / 2, y: H - 6,
    "text-anchor": "middle", "font-size": 12, fill: "#2F3437"
  });
  xLab.textContent = spec.x_label || `F(${df1}, ${df2})`;
  svg.appendChild(xLab);

  const yLab = svgEl("text", {
    x: 12, y: m.t + plotH / 2,
    "text-anchor": "middle", "font-size": 12, fill: "#2F3437",
    transform: `rotate(-90 12 ${m.t + plotH / 2})`
  });
  yLab.textContent = "Density";
  svg.appendChild(yLab);

  const figure = document.createElement("figure");
  figure.className = "agent-figure";
  figure.appendChild(svg);

  if (spec.caption) {
    const cap = document.createElement("figcaption");
    cap.textContent = spec.caption;
    figure.appendChild(cap);
  }

  return figure;
}

// Swaps any ```fplot code block in the sanitised output for the drawing.
// A block that is not valid JSON is left as it is, rather than disappearing.
function renderFigureBlocks(root) {
  root.querySelectorAll("pre > code.language-fplot").forEach(code => {
    let spec;
    try {
      spec = JSON.parse(code.textContent);
    } catch (error) {
      console.warn("fplot block is not valid JSON:", error);
      return;
    }
    try {
      code.parentNode.replaceWith(buildFPlot(spec));
    } catch (error) {
      console.error("Could not draw fplot block:", error);
    }
  });
}

function renderAssistantMessage(div, text) {
  const extracted = extractMath(text);

  const rendered = marked.parse(extracted.text, {
    gfm: true,
    breaks: true
  });

  div.innerHTML = DOMPurify.sanitize(rendered);

  restoreMath(div, extracted.math);
  renderFigureBlocks(div);
}

function addMessage(role, text) {
  const div = document.createElement("div");
  div.className = "message " + (role === "user" ? "user" : "assistant");

  if (role === "user") {
    div.textContent = text;
  } else {
    renderAssistantMessage(div, text);
  }

  messagesDiv.appendChild(div);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function isAllowedParentOrigin(origin) {
  try {
    const url = new URL(origin);

    // Local Quarto preview, e.g. http://localhost:3962
    if (
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1")
    ) {
      return true;
    }

    // Published Quarto site from this project.
    if (origin === "https://nishanmudalige.github.io") {
      return true;
    }
  } catch (error) {
    return false;
  }

  return false;
}

// Receive statistical context from the parent Quarto/RevealJS slide.
window.addEventListener("message", function (event) {
  if (event.source !== window.parent) return;
  if (!isAllowedParentOrigin(event.origin)) return;

  if (event.data && event.data.type === "ANOVA_PAGE_CONTEXT") {
    pageContext = event.data.context;
    console.log("ANOVA page context received:", pageContext);
  }
});

// Tell the parent that the message listener is ready. The parent validates
// that this message came from https://anova-agent.onrender.com before sending
// the course context back to the iframe.
if (window.parent !== window) {
  window.parent.postMessage(
    { type: "ANOVA_AGENT_READY" },
    "*"
  );
}

async function sendMessage() {
  const message = messageInput.value.trim();
  if (!message) return;

  addMessage("user", message);
  messageInput.value = "";
  sendButton.disabled = true;
  sendButton.textContent = "...";

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: message,
        history: history,
        page_context: pageContext
      })
    });

    if (!response.ok) {
      throw new Error("Server returned " + response.status);
    }

    const data = await response.json();
    addMessage("assistant", data.response);

    history.push({
      role: "user",
      content: message
    });

    history.push({
      role: "assistant",
      content: data.response
    });
  } catch (error) {
    addMessage(
      "assistant",
      "I couldn't connect to the AI service."
    );
    console.error(error);
  } finally {
    sendButton.disabled = false;
    sendButton.textContent = "Send";
    messageInput.focus();
  }
}

sendButton.addEventListener("click", sendMessage);

messageInput.addEventListener("keydown", function (event) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});
