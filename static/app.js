const messagesDiv = document.getElementById("messages");
const messageInput = document.getElementById("messageInput");
const sendButton = document.getElementById("sendButton");

let history = [];
let pageContext = null;

function addMessage(role, text) {
  const div = document.createElement("div");
  div.className = "message " + (role === "user" ? "user" : "assistant");
  div.textContent = text;
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
