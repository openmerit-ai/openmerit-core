# Escalation router: decides whether a ticket needs a human now.
import os

ROUTER_MODEL = "gpt-5.4"
FALLBACK_MODEL = os.environ.get("ESCALATION_MODEL")


def route(client, ticket):
    return client.chat.completions.create(model=ROUTER_MODEL, messages=[{"role": "user", "content": ticket}])
