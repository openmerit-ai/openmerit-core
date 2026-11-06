# Scout data policy

Updated 6 November 2026.

OpenMerit operates Scout. This policy covers its hosted website and connected clients.

**Don't submit confidential or sensitive information.** Automated redaction is not guaranteed to remove it.

## Data we use

- **Service data:** Your submitted task and related information are processed by an AI service provider, even with analytics off. We also retain account, authorization and device details needed to provide access.
- **Measured results:** On enabled deployments, reported and imported evaluation aggregates are stored with your Scout account and used only for your recommendations across conversations, as detailed under Evaluation connections below. Send aggregates only, never the inputs, outputs or records they were measured on.
- **Optional analytics:** When enabled, we collect usage, recommendations, feedback, setup activity, device/browser categories, performance and error information to improve Scout and fix problems. Account analytics may include your name, verified email and sign-in provider, and may link activity before and after sign-in.
- **Shared content:** When prompt sharing is enabled, analytics also includes task text and analysis. We use this for product improvement, not foundation model training. There is no session recording.

Service providers handle hosting, AI processing, sign-in and analytics on our behalf. They have their own retention and security policies; processing is not guaranteed to stay in one region or have zero retention. External coding agents and linked services have separate policies.

## Your choices

Manage sharing in [Privacy & analytics](/scout/privacy/). Browser usage analytics and prompt sharing default on unless you previously opted out. Saved opt-outs, Do Not Track and Global Privacy Control are respected.

You can disable usage analytics, disable prompt sharing, or stop linking this browser's activity to your account. Unlinking does not remove earlier links or stop separate account-profile analytics; task text can still identify you.

Setup analytics defaults on. Set `OPENMERIT_TELEMETRY=0` or `DO_NOT_TRACK=1` to disable it. Installed coding-agent connections do not share prompt content for analytics. Terminal and evaluation analytics remain opt-in. Rerun setup to apply changed preferences to existing installations.

Turning sharing off stops future optional collection. It does not stop required processing or delete stored data.

## Evaluation connections

These features require a matching Scout serving deployment; saving Langfuse
credentials also requires a dedicated server encryption secret. The npm package
does not deploy or enable the hosted connector. On enabled deployments, reported
and imported aggregates are held per authenticated user
in Cloudflare Durable Objects and inform only that user's recommendations across
conversations. No cross-customer sharing is enabled. Each aggregate records level,
kind (quality, USD or seconds), task/scope, catalogue model/endpoint ID, metric,
average/value, sample count, direction, source label and report/import time.
Do not put record IDs, emails or sensitive information in labels; identifier-like
source/scope labels trigger warnings, not guaranteed redaction.

Connecting Langfuse sends a separate Viewer key pair and mappings from the
signed-in browser, headless CLI, authenticated API or trusted MCP client to Scout,
encrypted at rest with a dedicated Worker secret. Headless management uses a
separately approved connection-management key; existing recommendation keys do
not gain that permission. The CLI reads Viewer credentials from a protected stdin
pipe or secret-manager-injected environment, not command arguments, and does not
save those Viewer credentials locally. MCP accepts them through client-controlled
HTTP headers, not model-visible tool arguments. Keep client, proxy and shell logs
from recording credentials. The management key is stored separately on your
device until revoked/deleted and can delete all evaluation data for your account;
disconnecting Langfuse does not revoke it. First-time device authorization still
requires account sign-in and approval. The web connection UI remains optional.
Scout requests only experiment headers/metadata and aggregate metric averages
and counts. It does not request inputs, outputs, trace/observation bodies,
experiment items, raw scores or score comments. Arbitrary metadata is discarded;
experiment source labels are hashed. A deliberately invalid write-permission
probe does not send a valid dataset or create traces. Your Langfuse region does
not constrain Scout's storage or AI-provider region.

At most 5,000 aggregates or 1 MB are retained per user. Rows expire 90 days after
report/import, are excluded from recommendations at expiry and pruned daily;
cleanup may be delayed by platform scheduling. The evaluation account, including
its encrypted connection, is erased after 90 days without a report, connection
or successful sync. Backups and infrastructure logs follow provider policies;
immediate backup erasure has not been independently verified.

On the signed-in [connection page](/connect/?integration=langfuse), disconnecting
deletes the key and imported aggregates, including imports from an in-flight
sync. **Delete all evaluation data** also deletes reported aggregates. Past
conversation text and recommendations remain and may mention prior results;
request broader deletion through the contact below. Legacy per-conversation
aggregates migrate when that conversation next receives a turn. Old conversations
not reopened require the broader deletion request.

## Storage and retention

- Your browser stores sign-in information, sharing preferences and temporary task drafts.
- Task data and results may be stored temporarily even with analytics off: short-lived results for 30 seconds and completed-search processing data for seven days. Expiry is not a guarantee of immediate erasure.
- Newly shared task content has a 30-day analytics retention window. Other analytics and account records may remain longer under provider settings. Backup erasure has not been independently verified.
- Older task records may fall outside that 30-day policy. A discontinued archive follows a three-month retention period and is not automatically covered by account deletion.
- We retain access and privacy-preference records as needed to operate the service and honor opt-outs and deletion requests.

## Contact and deletion

For data access, correction or deletion, contact [lazim@openmerit.ai](mailto:lazim@openmerit.ai). We may verify account ownership. Do not send passwords or sensitive task content.

Account deletion requests deletion of linked analytics. Erasure is asynchronous; unlinked activity and historical records may require separate review. Turning off sharing does not delete past data. Your rights depend on applicable law.
