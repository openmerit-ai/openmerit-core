// Inbound email for openmerit.ai aliases that reach more than one person.
// An Email Routing rule forwards to exactly one destination, so each such alias
// routes to this Worker instead, which forwards the message to everyone listed.
// Every destination must be a verified Email Routing address in the account.
// Runbook: docs/site-deployment.md#email-forwarding.

/** The part of Cloudflare's ForwardableEmailMessage this Worker uses. */
export interface InboundEmail {
  readonly to: string;
  forward(rcptTo: string): Promise<unknown>;
  setReject(reason: string): void;
}

const recipients: Readonly<Record<string, readonly string[]>> = {
  "code@openmerit.ai": ["code@lazim.one", "prvn431@gmail.com"],
};

export default {
  async email(message: InboundEmail): Promise<void> {
    const destinations = recipients[message.to.toLowerCase()];
    if (!destinations) return message.setReject("Unknown address");
    await Promise.all(destinations.map((address) => message.forward(address)));
  },
};
