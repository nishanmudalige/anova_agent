import os

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from agents import Agent, Runner


app = FastAPI()


# --------------------------------------------------
# OpenAI agent
# --------------------------------------------------

anova_agent = Agent(
    name="ANOVA Teaching Assistant",

    model="gpt-5.6-luna",

    instructions="""
You are an AI teaching assistant for an undergraduate
statistics course.

The current activity concerns one-way ANOVA applied to
brush turkey incubation periods measured at different
temperature groups.

Your role is to help students reason about statistical
concepts rather than simply giving answers immediately.

For this activity, students may ask about:

- the equal variance assumption
- comparing group standard deviations
- interpreting boxplots
- one-way ANOVA assumptions
- the ANOVA F statistic
- p-values
- post-hoc comparisons

When discussing equal variance:

1. Encourage students to compare the spreads of the groups.
2. Explain that similar standard deviations support the
   equal variance assumption.
3. Also encourage students to inspect boxplots for
   substantially different spreads.
4. Do not claim that you can see a graph or R output unless
   the student has provided the relevant information.
5. Keep explanations concise and appropriate for a
   second-year undergraduate statistics course.
"""
)


# --------------------------------------------------
# Request format
# --------------------------------------------------

class ChatRequest(BaseModel):
    message: str
    history: list[dict] = []


# --------------------------------------------------
# API
# --------------------------------------------------

@app.post("/api/chat")
async def chat(request: ChatRequest):

    # Build a small transcript so the agent has the
    # conversation context.
    transcript = ""

    for item in request.history:
        role = item.get("role", "")
        content = item.get("content", "")

        if role == "user":
            transcript += f"Student: {content}\n"
        elif role == "assistant":
            transcript += f"Assistant: {content}\n"

    transcript += f"Student: {request.message}\nAssistant:"

    result = await Runner.run(
        anova_agent,
        transcript
    )

    return {
        "response": result.final_output
    }


# --------------------------------------------------
# Health check for Render
# --------------------------------------------------

@app.get("/health")
def health():
    return {"status": "ok"}


# --------------------------------------------------
# Static website
# --------------------------------------------------

app.mount(
    "/",
    StaticFiles(
        directory="static",
        html=True
    ),
    name="static"
)
