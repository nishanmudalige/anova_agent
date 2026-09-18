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

function renderAssistantMessage(div, text) {
  const extracted = extractMath(text);

  const rendered = marked.parse(extracted.text, {
    gfm: true,
    breaks: true
  });

  div.innerHTML = DOMPurify.sanitize(rendered);

  restoreMath(div, extracted.math);
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
