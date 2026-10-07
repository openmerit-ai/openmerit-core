# Inference Terminal design notes

Internal implementation and design review for the unreleased local terminal, 7 October 2026. This file is deliberately outside public documentation navigation. User-facing behavior is maintained in `inference-terminal.md`.

## Context

A working environment overview for developers and agents, often consulted during focused or uncertain work. The interface should make the state of the environment legible without demanding constant attention. Model selection, evaluation authoring, prompt management, and trace debugging remain outside this product surface.

## References and skills

- Emil Kowalski's `emil-design-eng` skill: immediate keyboard actions, purposeful motion, bounded transitions, reduced-motion support, and explicit press feedback.
- [Josh Puckett's Interface Craft](https://interfacecraft.dev): installed using the user-requested installer; applied its design critique and named-timing guidance.
- [Lochie’s Torph examples](https://torph.lochie.me/examples): actual Torph integration for continuity across changing characters and values.
- [Benji Taylor’s Liveline](https://benji.org/liveline): actual Liveline canvases for passively sampled machine history.
- [Rauno Freiberg's interaction work](https://rauno.me/craft): precision of interaction and restrained detail.
- [Charlie Aufmann and Maxime Heckel on Linear's calmer interface](https://linear.app/now/behind-the-latest-design-refresh): quiet navigation, selective visual emphasis, softer structure, and reduction of unnecessary icon treatments.

## First impressions

The environment map creates the main point of orientation. The first pass was visually coherent but its map column labels did not align with the actual rendered SVG nodes. Some headings described the design's intended mood instead of naming the view. Both were corrected in the browser pass.

## Visual design

The palette uses neutral graphite surfaces and silver controls, with no green tint. Solid fills, fine borders, and restrained shadows define hierarchy; decorative surface gradients and chart area fills are removed. Data colors identify the reported request path consistently: royal blue for direct API connections, amber for local runtimes, violet for routers, cyan for gateways, and gray for unclassified paths. Direct API uses a deeper, more saturated blue than the earlier pastel palette; gateway cyan is brighter and more saturated to separate the two. A shared legend and explicit labels accompany these colors. This replaces the earlier local/cloud map coloring; location remains textual metadata. Sample disclosures and unavailable states retain their labeled amber treatment. Typography uses the platform's native system font, with tabular figures and a system monospace for measurements. All assets are bundled; there are no font CDNs, stock icon libraries, or remotely loaded dependencies.

| Before | After | Why |
| --- | --- | --- |
| A small sample hid how navigation, the map, and inventories behave under volume | Atlas contains 40 agents, 140 tasks, 21 models, and 9,600 fictional requests, with inspectable agent/task counts | Exercise density and missing-data states while keeping the overview bounded and the full records discoverable |
| Map slots filled from insertion order and could show only direct APIs | Rank workloads by volume and preserve path diversity within the existing node caps | Make a busy environment representative without turning the graph into an unreadable mesh |
| Provider initials and generic local-model diamonds in boxed tiles | Model names lead each row, with provider metadata and request paths aligned below | Remove placeholder symbols that duplicate the provider text and give the inventory a cleaner reading edge |
| Identical line swatches required color to distinguish every path | Five custom connection glyphs shared by badges, legends, and map nodes | Give each type a meaningful shape; keep text labels and hide decorative SVGs from assistive technology |
| Silver gateways blended into white interface text; the earlier pastel cyan was too close to pale blue | Saturated cyan gateways paired with deeper royal-blue Direct API connections | Separate the pair in both hue and brightness, keeping gateway markings chromatic and neutral text outside the category palette |
| “Direct provider” described the company as a connection type | “Direct API” in legends, badges, and accessible map descriptions | Name how the request reaches the provider |
| Local/cloud colors obscured routers, gateways, and direct provider calls | One path palette across map threads, totals, model labels, connection cards, and stacked request counts | Follow a connection across views without confusing the endpoint's location with how it was reached |
| Sidebar section labels at 9 px with faint text | 12 px medium-weight labels, stronger contrast, and a little more space below | Make Workspace and Infrastructure readable at a glance |
| Green accents, tinted surfaces, and decorative gradients | Neutral graphite, silver selection and measurements, solid surfaces, and unfilled chart lines | Honor the user's palette and surface preferences throughout the terminal |
| HTML column labels and a centered SVG used different coordinates | Labels and nodes share the SVG coordinate system | Connections remain aligned at every desktop width |
| Headings such as “The shape of your inference” | “Inference activity,” “Model inventory,” and “Sources & coverage” | Name the task directly |
| A zero sparkline appeared without an activity source | Unknown samples produce a dashed baseline | Missing collection must not look like measured inactivity |
| Search relied only on native dialog Escape behavior | Explicit Escape dismissal with restored focus | A search input must not swallow the expected close action |
| Whole-machine memory appeared as a generic capacity indicator | Includes system/cache disclosure and fractional percentage | Low OS free memory is not a diagnosis of inference pressure |
| Flat navigation with equally weighted rows | Grouped navigation, inset workspace/search controls, a raised moving selection, and source coverage | Establish hierarchy without adding ornament |
| Root HTML replacement on every poll | Keyed reconciliation preserves Torph controllers and React chart roots | Keep focus, selected metrics, and chart state across updates |
| Static CPU sparkline with limited inspection | Liveline CPU/memory history plus exact-sample readout | Make passive resource changes legible without implying per-request attribution |
| The mobile diagram shrank labels below readable size | An independently scrollable map with a scroll hint | Keep node labels and targets readable |

## Interface design

The overview has four summary values, one relationship map, one compute panel, and concise model/activity lists. Deeper detail uses a single inspector. All six views are implemented; no navigation leads to a placeholder. Sources expose their coverage instead of treating disconnected systems as healthy zeroes. Sample mode has both a persistent top label and a disclosure above the content.

## Consistency and interactions

Small custom SVGs share stroke weights and geometry. Detail actions share one dialog and Escape behavior. The command palette is immediate. Pointer-opened inspectors settle six pixels over 220 ms; keyboard and reduced-motion interactions stay immediate. Top navigation selection is immediate; Torph changes settle over 260 ms. Repeated keyboard actions bypass both. Liveline scrolls the sampled history and interpolates between readings, holding the latest value between polls. Its pulse, momentum indicators, and particles are disabled. Reduced motion renders static SVG readings; offscreen canvases unmount, and Liveline stops drawing in background tabs. Request-volume bars remain discrete counts. Exact machine samples can be inspected using the keyboard. The environment graph is interactive through both pointer and keyboard input.

## User context

A user should be able to leave the terminal open without feeling that inference depends on it. The browser reads a cached local view, and polling failures explicitly say the workload is unaffected. Costs are labeled with their coverage; unknown measurements remain dashes. Local runtime inventory, request events, and runtime counters retain their distinct meanings.

## Verification

Browser review covered all six views at 1512 and 390 pixels, source setup, sample/live separation, model filters and search, time-window changes, model and graph inspectors, command search, and Escape behavior. Automated tests cover passive collector boundaries, import correctness, source precedence, and loopback access. The refinement also verified persistent canvas and sidebar identity over a poll, chart metric preservation, sampled-value keyboard navigation, compact navigation, and zero movement animations under reduced motion. The npm package includes the executable with execute permissions and all four static assets. Full repository verification passed, including documentation generation and link checks. Browser verification also covered dark-only rendering under a light OS preference, reduced motion, and loss of the local server while preserving the last snapshot. No deployment or npm release is part of this work.

## Deployment-aware environment — 7 October 2026

The environment explorer connects source-reported agents, paths, model deployments, and declared shared pools. The overview stays bounded; an agent selector and linked inspectors expose detail. No new primary navigation destination is needed.

| Before | After | Why |
| --- | --- | --- |
| A model name ended the map | Model name plus distinct deployment identity | The same model may run in multiple places; unresolved identity remains explicit |
| One connection implied the path | Entry connection with hop count and ordered path inspector | Show only reported intermediaries |
| Whole-machine compute beside the map | Three shared capacity readings with source freshness | Make common dependencies visible; hardware remains in Local compute |
| Agent detail becomes a long stack | Compact summary plus Deployments / Paths / Capacity buttons | Keep the initial inspection manageable at enterprise scale |
| Capacity could be mistaken for an agent measurement | Whole-pool scope, shared-agent links, timestamps, and stale/unknown states | Preserve evidence boundaries |
| Refresh replaces an open inspector | Reconcile inspector children and keyed controls in place | Preserve scroll and keyboard focus while readings update |

Motion retains the existing 220 ms inspector reveal for pointer use; keyboard navigation and reduced motion stay immediate. Exploration buttons switch without movement; capacity bars do not animate fabricated intermediate readings. Path colors remain blue, amber, violet, cyan, and gray. No additional gradients or decorative identity tiles were introduced.

## Title treatment — 7 October 2026

| Before | After | Why |
| --- | --- | --- |
| Small uppercase labels above page, inspector, and inventory-card titles | Titles lead directly; useful provider and residency context sits beneath model-card titles | Remove the repeated overline aesthetic throughout the terminal, as requested |

## Dropdown treatment — 7 October 2026

| Before | After | Why |
| --- | --- | --- |
| Platform chevron at the edge of a native select | Shared trigger with a 14 px chevron and fixed 11 px right inset | Keep the arrow aligned and give the text consistent breathing room |
| Blue platform focus and menu selection | Neutral focus ring, pressed border, dark menu, and selected-row check | Match the rest of the terminal |
| Native menu varied by platform | Select-only combobox with arrow navigation, typeahead, Home/End, Escape cancellation, and Tab commit | Maintain explicit keyboard behavior while using the shared styling |
| A poll could replace the open selector | Preserve menu state while collection continues | Avoid moving options during selection |

The menu is placed outside clipped panels, flips above the trigger when needed, and stays within viewport edges. Only a 120 ms opacity cue is used on pointer opening; keyboard and reduced-motion opening are immediate. Browser checks cover selection, cancellation, typeahead, Tab focus, outside dismissal, menu scrolling, viewport placement, and persistence over a poll.

## Activity, fleet, and identity refinement — 7 October 2026

| Before | After | Why |
| --- | --- | --- |
| Compressed rainbow stacks with tiny SVG labels | Full-width neutral volume bars, readable HTML axes, and selectable path summaries | Keep the activity graph consistent with the terminal and let a single path receive focus |
| 9px muted table headers | 12px medium-weight headers | Give dense tables a readable hierarchy |
| One machine implied the entire environment | Site/rack inventory, host selection, per-host history and accelerator readings | Represent private hardware without averaging unlike devices or inventing network discovery |
| “Models in local memory” | Host-specific “Loaded models,” runtime identity, and explicit allocation type | Separate residency from system RAM and device utilization |
| Unrecognizable named provider cards | Small official favicons from a bounded local registry | Improve recognition without decorative initials, remote lookups, or replacing path icons |
| Overview counts prefixed with “Observed” | Counts lead directly, retaining selected-window scope | Reduce redundant copy |

Host inventory and identity changes are unreleased. The sample fleet has six hosts, two racks, eleven accelerators, and seven explicitly placed loaded models. Exported measurements retain their own timestamps and missing residency remains unknown. Keyboard controls use the shared select and immediate interactions; chart bins use one tab stop with arrow-key inspection. Brand provenance is recorded in `packages/terminal/brand-assets.json`.

## Identity continuity — 7 October 2026

| Before | After | Why |
| --- | --- | --- |
| Official marks appeared only on connection cards | A shared identity renderer serves tables, maps, activity, residency, sources, capacity, search, and inspectors | The same entity stays recognizable across views |
| Runtime names were the only identity for locally hosted models | A model-family mark leads, with a distinct runtime mark where applicable | Qwen through Ollama and Llama through vLLM retain both identities |
| Missing model marks could invite arbitrary initial tiles | Unknown model families and custom namespaces remain text-only | Avoid decoration that implies unsupported attribution |
| Icon tooltips could duplicate names in accessible button labels | Decorative marks are explicitly hidden from assistive technology | Preserve concise keyboard and screen-reader navigation |

Official Qwen, Meta, Nomic, and BAAI assets extend the existing local registry. Every sample model uses the same resolved maker across record, deployment, inventory, and residency representations. Service recognition is exact; model recognition uses anchored family patterns and bounded namespace rules. No animations were added to repeated identity marks.


## Source-backed naming and density — 7 October 2026

The terminal is a passive evidence view. Polished fictional agent roles and site names gave the sample an unjustified sense of discovery; quieter typography alone could not resolve that expectation. The revision keeps source identifiers visible and exposes provenance only when an identity is inspected.

| Before | After | Why |
| --- | --- | --- |
| “Knowledge / Research,” descriptive tasks, and “Company gateway” | Code-style fixture IDs, `llm-gateway`, and absent display names that fall back to IDs | Demonstrate the metadata contract without implying code analysis or role discovery |
| A workstation assigned to “Studio” | Full system hostname for real local hardware; export-provided site/rack only | Physical placement cannot be inferred from a machine name |
| “Compute” | “Local compute,” explicitly including exported self-hosted servers | Clarify the scope beside cloud model providers |
| Neutral all-path chart | Colored path stacks with the existing full-width layout and selectable categories | Restore the category thread while retaining readable axes and keyboard inspection |
| Tiny activity subtitles | 12px secondary identity text and 14px maker marks | Keep the agent/model relationship readable in dense rows |
| Source rows with 22px vertical padding | 13px vertical padding with a 64px minimum target | Fit source coverage into a shorter scan without shrinking its labels |

Inspectors identify the metadata fields and source behind agent/task names, distinguish absent names from IDs, and describe deployment links as recorded activity. Names supplied by an exporter may still be human-readable: this change removes automatic embellishment, not explicit user labels. There is no new code scanner, runtime hook, network discovery, or inferred task lifecycle. Keyboard operations remain immediate; no motion was added to the chart or identity metadata.


## Top navigation — 7 October 2026

The terminal is a frequently consulted workspace. The persistent side column gave navigation and collection status too much weight relative to inference data. This revision places navigation on the same horizontal grid as the content, retaining quick access without competing with the environment map.

| Before | After | Why |
| --- | --- | --- |
| Sidebar, workspace tile, icon rows, section labels, and coverage card | Two compact header rows with product identity, environment/search controls, and six text tabs | Reduce chrome and give the data more horizontal room |
| Raised moving navigation selection | A thin underline with immediate selection and a short text-color hover | Make repeated navigation direct and quiet |
| Collapsed rail saved in local storage | One header layout at all desktop widths | Remove an unnecessary layout mode and its controls |
| Separate mobile brand, navigation, and breadcrumb rows | A 105px header with a horizontally scrolling tab row | Keep navigation compact while preserving environment switching and search |
| A wide layout anchored to a left rail | A centered 1520px maximum grid with responsive gutters | Align the header, tables, diagrams, and summary measurements |

Tabs use manual keyboard activation: arrows, Home, and End move focus; Enter/Space activates. Navigation preserves focus on the selected tab and reveals it in the scrollable strip. Polls preserve the focused tab and strip position. Direct hash views, command search, workspace selection, source coverage, and inspectors remain accessible. The retired sidebar styles, local-storage preference, marker animation, and hover-tracking code are removed. No new animations are introduced for navigation.
