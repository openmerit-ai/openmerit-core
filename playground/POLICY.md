# Sahra Health model and data policy

Sahra Health is a fictional health insurer in Dubai. This policy is what our coding agents give Scout when choosing application models. Scout's machine-readable policy is in `.openmerit/scout.json`, written by `openmerit project`.

## Data residency (UAE)

Health data must stay in the UAE. Federal Law No. 2 of 2019 on the use of ICT in health fields, Article 13, says that health data and information about health services provided in the UAE may not be stored, processed, generated or transferred outside the UAE, except in cases set by a decision of the health authority in coordination with the Ministry ([official text](https://uaelegislation.gov.ae/en/legislations/1209)).

For model choices this means:

- Any model that receives member, claim, diagnosis, procedure or bill content must run on infrastructure in the UAE, or under an exception we can cite.
- A model hosted outside the UAE is acceptable only as a recorded gap, never silently.
- Model recommendations must say where the endpoint processes data. "Unknown" counts as outside the UAE.

**The playground does not meet this policy, and says so.** Workers AI, Durable Objects and Langfuse Cloud (US region) all process data outside the UAE. That is acceptable only because every record here is fictional. We keep the rule so we can see whether Scout and our coding agents respect it.

## Inventory and providers

- **Existing provider:** Cloudflare Workers AI, through the Worker's `AI` binding. This is policy `existing-first`.
- **New providers:** if Scout recommends a model outside Workers AI, we may add that provider's key with the owner's approval each time, and record the residency gap in `MODEL-DECISIONS.md`.

## Other requirements for model choices

- Agents call tools (Pi Durable tool calls with JSON schemas) and must follow multi-step instructions reliably.
- English input, including medical coding vocabulary (ICD-10-CM, CPT) and free-text bills.
- Fixtures and tests are fictional. Never send real member data to Scout or any model.
