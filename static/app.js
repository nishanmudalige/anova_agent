const messagesDiv =
  document.getElementById("messages");

const messageInput =
  document.getElementById("messageInput");

const sendButton =
  document.getElementById("sendButton");


let history = [];


function addMessage(role, text) {

  const div = document.createElement("div");

  div.className =
    "message " +
    (role === "user" ? "user" : "assistant");

  div.textContent = text;

  messagesDiv.appendChild(div);

  messagesDiv.scrollTop =
    messagesDiv.scrollHeight;
}


async function sendMessage() {

  const message =
    messageInput.value.trim();

  if (!message) return;


  addMessage("user", message);

  messageInput.value = "";

  sendButton.disabled = true;
  sendButton.textContent = "...";


  try {

    const response =
      await fetch("/api/chat", {

        method: "POST",

        headers: {
          "Content-Type": "application/json"
        },

        body: JSON.stringify({
          message: message,
          history: history
        })

      });


    if (!response.ok) {
      throw new Error(
        "Server returned " +
        response.status
      );
    }


    const data =
      await response.json();


    addMessage(
      "assistant",
      data.response
    );


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


sendButton.addEventListener(
  "click",
  sendMessage
);


messageInput.addEventListener(
  "keydown",
  function(event) {

    if (
      event.key === "Enter" &&
      !event.shiftKey
    ) {

      event.preventDefault();
      sendMessage();

    }

  }
);
