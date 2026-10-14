# Auto routing is probably the worst thing you could do if you care about model selection

6 Oct 2026 · OpenMerit

Do not outsource model selection to a setting called “auto.” Choosing an AI that produces an answer is easy. Establishing that it completes your work correctly is the job—and a router’s choice is not that evidence.

---

A model is the AI doing the work. Routing delivers a request to a model. Auto routing adds a decision: the service chooses the model for you. **That decision changes who does the work without, by itself, checking that the work gets done.**

```memo-svg
<svg viewBox="0 0 760 325" role="img" aria-label="Routing delivers work to a chosen model. Auto routing also chooses the model, which creates a separate need to validate that choice.">
<text x="24" y="32" font-size="17" fill="var(--cds-text-primary)" font-weight="600">What the word “auto” adds</text>
<text x="24" y="57" font-size="12" fill="var(--cds-text-secondary)">Delivering a request and justifying a model choice are separate jobs.</text>
<text x="24" y="96" font-size="11" fill="var(--cds-chart-categorical-1)">ROUTING</text>
<rect x="24" y="111" width="322" height="58" rx="6" fill="var(--cds-chart-categorical-1)" stroke="var(--cds-chart-categorical-1)" fill-opacity=".10" stroke-width="1.1"/>
<text x="185" y="146" text-anchor="middle" font-size="14" fill="var(--cds-text-primary)">You specify the model</text>
<path d="M358 140H402 M396 135L402 140L396 145" fill="none" stroke="var(--cds-chart-categorical-1)" stroke-width="1.25"/>
<rect x="414" y="111" width="322" height="58" rx="6" fill="var(--cds-chart-categorical-1)" stroke="var(--cds-chart-categorical-1)" fill-opacity=".05" stroke-width="1.1"/>
<text x="575" y="146" text-anchor="middle" font-size="14" fill="var(--cds-text-primary)">The router sends it the request</text>
<text x="24" y="200" font-size="11" fill="var(--cds-chart-status-warning)">AUTO ROUTING</text>
<rect x="24" y="215" width="322" height="58" rx="6" fill="var(--cds-chart-status-warning)" stroke="var(--cds-chart-status-warning)" fill-opacity=".13" stroke-width="1.1"/>
<text x="185" y="250" text-anchor="middle" font-size="14" font-weight="600" fill="var(--cds-text-primary)">The router chooses the model</text>
<path d="M358 244H402 M396 239L402 244L396 249" fill="none" stroke="var(--cds-chart-status-warning)" stroke-width="1.25"/>
<rect x="414" y="215" width="322" height="58" rx="6" fill="var(--cds-chart-status-warning)" stroke="var(--cds-chart-status-warning)" fill-opacity=".06" stroke-width="1.1"/>
<text x="575" y="250" text-anchor="middle" font-size="14" fill="var(--cds-text-primary)">The router sends it the request</text>
<text x="24" y="307" font-size="13" font-weight="600" fill="var(--cds-text-primary)">Neither path, on its own, proves that the chosen model can do your job.</text>
</svg>
```

OpenRouter Auto Router uses market spending to guide that choice. Pareto Code uses coding-test rankings. Neither selection rule includes a test of your finished work. That missing check is why we would not use either as our model-selection process. [1](#source-1-auto-router) [3](#source-3-pareto-code-router)

## An answer can arrive while the work fails

In an earlier OpenMerit support experiment, a cheap model wrote reassuring replies while missing required refunds or escalations on three of five tickets. This was an early candidate, not an Auto Router run. It shows the failure a selector needs to be tested for. [2](#source-2-openmerit-experiment)

```memo-svg
<svg viewBox="0 0 760 265" role="img" aria-label="An earlier candidate claimed to escalate cases but omitted refunds or escalations on three of five tickets">
<text x="24" y="32" font-size="17" fill="var(--cds-text-primary)" font-weight="600" text-anchor="start">The reply said the job was done</text><text x="24" y="55" font-size="12" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">An earlier cheap candidate in OpenMerit’s support experiment</text><rect x="24" y="83" width="334" height="120" rx="6" fill="var(--cds-chart-categorical-1)" stroke="var(--cds-chart-categorical-1)" stroke-width="1.1" fill-opacity=".06"/><rect x="402" y="83" width="334" height="120" rx="6" fill="var(--cds-chart-status-critical)" stroke="var(--cds-chart-status-critical)" stroke-width="1.1" fill-opacity=".12"/><text x="44" y="112" font-size="11" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">WHAT THE CUSTOMER READ</text><text x="44" y="151" font-size="18" fill="var(--cds-text-primary)" font-weight="500" text-anchor="start">“I’ve escalated your case.”</text><text x="422" y="112" font-size="11" fill="var(--cds-chart-status-critical)" font-weight="400" text-anchor="start">WHAT THE AGENT DID</text><text x="422" y="148" font-size="15" fill="var(--cds-chart-status-critical)" font-weight="600" text-anchor="start">Missed refunds or escalations</text><text x="422" y="180" font-size="15" fill="var(--cds-chart-status-critical)" font-weight="600" text-anchor="start">on 3 of 5 tickets</text><line x1="367" y1="143" x2="392" y2="143" stroke="var(--cds-chart-axis)" stroke-width="1.25"/><text x="24" y="239" font-size="13" fill="var(--cds-text-primary)" font-weight="600" text-anchor="start">A convincing answer can hide a missing action.</text>
</svg>
```

**A reply arriving successfully does not mean the job succeeded.** Pareto Code’s documented backup models take over for service errors or rate limits. A convincing wrong answer can arrive without either. Checking whether the refund happened requires a separate check of the work. [3](#source-3-pareto-code-router)

## The check before the change

Our prototype tried cheaper models on recorded examples from each step before a person approved a switch. We call this a replay. The diagram from our experiment shows where that check happens—and where Auto Router makes its selection. [2](#source-2-openmerit-experiment)

```memo-svg
<svg viewBox="0 0 760 596" role="img" aria-label="OpenMerit replays each call site before approval while Auto Router selects by topic and cost tier" font-size="13">
<defs>
<marker id="cmp-arrow-olive" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
<path d="M0 0L10 5L0 10z" fill="var(--cds-chart-categorical-1)">
</path>
</marker>
<marker id="cmp-arrow-terracotta" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
<path d="M0 0L10 5L0 10z" fill="var(--cds-chart-status-warning)">
</path>
</marker>
</defs>
<text x="24" y="30" font-size="15" font-weight="600" fill="var(--cds-text-primary)">Two approaches to changing a model</text>
<text x="184" y="70" text-anchor="middle" font-size="14" font-weight="600" fill="var(--cds-chart-categorical-1)">OpenMerit prototype · per step</text>
<text x="576" y="70" text-anchor="middle" font-size="14" font-weight="600" fill="var(--cds-chart-status-warning)">Auto Router · per request</text>
<g fill="none" stroke="var(--cds-chart-axis)" stroke-width="1.25">
<path d="M184 148V172" marker-end="url(#cmp-arrow-olive)" stroke="var(--cds-chart-categorical-1)">
</path>
<path d="M184 228V252" marker-end="url(#cmp-arrow-olive)" stroke="var(--cds-chart-categorical-1)">
</path>
<path d="M184 308V332" marker-end="url(#cmp-arrow-olive)" stroke="var(--cds-chart-categorical-1)">
</path>
<path d="M184 388V412" marker-end="url(#cmp-arrow-olive)" stroke="var(--cds-chart-categorical-1)">
</path>
<path d="M184 484V508" marker-end="url(#cmp-arrow-olive)" stroke="var(--cds-chart-categorical-1)">
</path>
<path d="M576 148V172" marker-end="url(#cmp-arrow-terracotta)" stroke="var(--cds-chart-status-warning)">
</path>
<path d="M576 228V252" marker-end="url(#cmp-arrow-terracotta)" stroke="var(--cds-chart-status-warning)">
</path>
<path d="M576 308V332" marker-end="url(#cmp-arrow-terracotta)" stroke="var(--cds-chart-status-warning)">
</path>
</g>
<g>
<rect x="24" y="92" width="320" height="56" rx="8" fill="var(--cds-chart-categorical-1)" fill-opacity=".06" stroke="var(--cds-chart-categorical-1)" stroke-width="1.1">
</rect>
<text x="184" y="116" text-anchor="middle" font-weight="600" fill="var(--cds-text-primary)">Record examples of the work</text>
<text x="184" y="132" text-anchor="middle" font-size="11.5" fill="var(--cds-text-secondary)">Save requests, actions and model usage</text>
</g>
<g>
<rect x="24" y="172" width="320" height="56" rx="8" fill="var(--cds-chart-categorical-1)" fill-opacity=".06" stroke="var(--cds-chart-categorical-1)" stroke-width="1.1">
</rect>
<text x="184" y="196" text-anchor="middle" font-weight="600" fill="var(--cds-text-primary)">Group examples by job step</text>
<text x="184" y="212" text-anchor="middle" font-size="11.5" fill="var(--cds-text-secondary)">Same instructions and available actions</text>
</g>
<g>
<rect x="24" y="252" width="320" height="56" rx="8" fill="var(--cds-chart-categorical-1)" fill-opacity=".06" stroke="var(--cds-chart-categorical-1)" stroke-width="1.1">
</rect>
<text x="184" y="276" text-anchor="middle" font-weight="600" fill="var(--cds-text-primary)">Label the task</text>
<text x="184" y="292" text-anchor="middle" font-size="11.5" fill="var(--cds-text-secondary)">Choose a relevant public ranking</text>
</g>
<g>
<rect x="24" y="332" width="320" height="56" rx="8" fill="var(--cds-chart-categorical-1)" fill-opacity=".06" stroke="var(--cds-chart-categorical-1)" stroke-width="1.1">
</rect>
<text x="184" y="356" text-anchor="middle" font-weight="600" fill="var(--cds-text-primary)">Shortlist cheaper models</text>
<text x="184" y="372" text-anchor="middle" font-size="11.5" fill="var(--cds-text-secondary)">Use rankings to decide what to test</text>
</g>
<g>
<rect x="24" y="412" width="320" height="72" rx="8" fill="var(--cds-chart-categorical-1)" fill-opacity=".16" stroke="var(--cds-chart-categorical-1)" stroke-width="1.1">
</rect>
<text x="184" y="436" text-anchor="middle" font-weight="600" fill="var(--cds-chart-categorical-1)">Try each step’s recorded examples</text>
<text x="184" y="452" text-anchor="middle" font-size="11.5" fill="var(--cds-text-primary)">Compare actions and replies with the original</text>
<text x="184" y="468" text-anchor="middle" font-size="11.5" fill="var(--cds-text-primary)">7 of 8 replays; 5 of 8 for polish</text>
</g>
<g>
<rect x="24" y="508" width="320" height="56" rx="8" fill="var(--cds-chart-categorical-1)" fill-opacity=".10" stroke="var(--cds-chart-categorical-1)" stroke-width="1.1">
</rect>
<text x="184" y="532" text-anchor="middle" font-weight="600" fill="var(--cds-chart-categorical-1)">A person approves</text>
<text x="184" y="548" text-anchor="middle" font-size="11.5" fill="var(--cds-text-secondary)">Replace the model at that step</text>
</g>
<g>
<rect x="416" y="92" width="320" height="56" rx="8" fill="var(--cds-chart-status-warning)" fill-opacity=".08" stroke="var(--cds-chart-status-warning)" stroke-width="1.1">
</rect>
<text x="576" y="116" text-anchor="middle" font-weight="600" fill="var(--cds-text-primary)">Each request arrives</text>
<text x="576" y="132" text-anchor="middle" font-size="11.5" fill="var(--cds-text-secondary)">Read the request to assign a topic</text>
</g>
<g>
<rect x="416" y="172" width="320" height="56" rx="8" fill="var(--cds-chart-status-warning)" fill-opacity=".08" stroke="var(--cds-chart-status-warning)" stroke-width="1.1">
</rect>
<text x="576" y="196" text-anchor="middle" font-weight="600" fill="var(--cds-text-primary)">Classify by topic</text>
<text x="576" y="212" text-anchor="middle" font-size="11.5" fill="var(--cds-text-secondary)">Our five steps shared one topic</text>
</g>
<g>
<rect x="416" y="252" width="320" height="56" rx="8" fill="var(--cds-chart-status-warning)" fill-opacity=".08" stroke="var(--cds-chart-status-warning)" stroke-width="1.1">
</rect>
<text x="576" y="276" text-anchor="middle" font-weight="600" fill="var(--cds-text-primary)">Rank by community spend</text>
<text x="576" y="292" text-anchor="middle" font-size="11.5" fill="var(--cds-text-secondary)">Highest spend share in the price band</text>
</g>
<g>
<rect x="416" y="332" width="320" height="56" rx="8" fill="var(--cds-chart-status-warning)" fill-opacity=".13" stroke="var(--cds-chart-status-warning)" stroke-width="1.1">
</rect>
<text x="576" y="356" text-anchor="middle" font-weight="600" fill="var(--cds-text-primary)">Answer with that model</text>
<text x="576" y="372" text-anchor="middle" font-size="11.5" fill="var(--cds-text-secondary)">No test on your recorded work here</text>
</g>
</svg>
```

**Auto Router chooses a replacement. Our prototype first checks whether to replace anything.** A ranking suggests what to try. The recorded work can give you a reason to keep the original.

## Popularity cannot tell you whether the work gets done

OpenRouter Auto Router ranks models by seven-day community spending within a topic and price band. A dollar spent is not a verified success. Even a perfectly measured buying pattern cannot tell you whether your refund happened. [1](#source-1-auto-router)

Our five steps all became `customer_support`. Each tested price tier selected one model for all five jobs. [2](#source-2-openmerit-experiment)

```memo-svg
<svg viewBox="0 0 760 365" role="img" aria-label="Five support call sites share one topic but have different success conditions">
<text x="24" y="32" font-size="17" fill="var(--cds-text-primary)" font-weight="600" text-anchor="start">One topic, five different jobs</text><text x="24" y="55" font-size="12" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">Observed topic in our Auto Router pilot. Each step needs a different check.</text><text x="24" y="88" font-size="11" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">STEP IN THE JOB</text><text x="298" y="88" font-size="11" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">ROUTER TOPIC</text><text x="470" y="88" font-size="11" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">WHAT HAS TO GO RIGHT</text><rect x="24" y="110" width="195" height="34" rx="6" fill="var(--cds-chart-categorical-1)" stroke="var(--cds-chart-categorical-1)" stroke-width="1.1" fill-opacity=".07"/><text x="38" y="132" font-size="13" fill="var(--cds-text-primary)" font-weight="400" text-anchor="start">Classify</text><line x1="220" y1="127" x2="275" y2="223" stroke="var(--cds-chart-status-warning)" stroke-width="1.25"/><text x="470" y="132" font-size="12" fill="var(--cds-text-primary)" font-weight="400" text-anchor="start">Choose the correct ticket category</text><rect x="24" y="158" width="195" height="34" rx="6" fill="var(--cds-chart-categorical-1)" stroke="var(--cds-chart-categorical-1)" stroke-width="1.1" fill-opacity=".07"/><text x="38" y="180" font-size="13" fill="var(--cds-text-primary)" font-weight="400" text-anchor="start">Order lookup</text><line x1="220" y1="175" x2="275" y2="223" stroke="var(--cds-chart-status-warning)" stroke-width="1.25"/><text x="470" y="180" font-size="12" fill="var(--cds-text-primary)" font-weight="400" text-anchor="start">Fetch the right order and facts</text><rect x="24" y="206" width="195" height="34" rx="6" fill="var(--cds-chart-categorical-1)" stroke="var(--cds-chart-categorical-1)" stroke-width="1.1" fill-opacity=".07"/><text x="38" y="228" font-size="13" fill="var(--cds-text-primary)" font-weight="400" text-anchor="start">Resolve</text><line x1="220" y1="223" x2="275" y2="223" stroke="var(--cds-chart-status-warning)" stroke-width="1.25"/><text x="470" y="228" font-size="12" fill="var(--cds-text-primary)" font-weight="400" text-anchor="start">Perform the permitted action</text><rect x="24" y="254" width="195" height="34" rx="6" fill="var(--cds-chart-categorical-1)" stroke="var(--cds-chart-categorical-1)" stroke-width="1.1" fill-opacity=".07"/><text x="38" y="276" font-size="13" fill="var(--cds-text-primary)" font-weight="400" text-anchor="start">Reply draft</text><line x1="220" y1="271" x2="275" y2="223" stroke="var(--cds-chart-status-warning)" stroke-width="1.25"/><text x="470" y="276" font-size="12" fill="var(--cds-text-primary)" font-weight="400" text-anchor="start">Describe what actually happened</text><rect x="24" y="302" width="195" height="34" rx="6" fill="var(--cds-chart-categorical-1)" stroke="var(--cds-chart-categorical-1)" stroke-width="1.1" fill-opacity=".07"/><text x="38" y="324" font-size="13" fill="var(--cds-text-primary)" font-weight="400" text-anchor="start">Reply polish</text><line x1="220" y1="319" x2="275" y2="223" stroke="var(--cds-chart-status-warning)" stroke-width="1.25"/><text x="470" y="324" font-size="12" fill="var(--cds-text-primary)" font-weight="400" text-anchor="start">Preserve facts while changing wording</text><rect x="280" y="198" width="165" height="50" rx="6" fill="var(--cds-chart-status-warning)" stroke="var(--cds-chart-status-warning)" stroke-width="1.1" fill-opacity=".14"/><text x="362" y="228" font-size="13" fill="var(--cds-chart-status-warning)" font-weight="600" text-anchor="middle">customer_support</text>
</svg>
```

Writing a polite reply and issuing the correct refund share a topic, but need different abilities. The topic can be correct while the model choice is wrong. Separate settings for each step still need tests to justify them.

## A good exam score does not prove it can do your job

Pareto Code groups models by public coding-test rankings, then selects the cheapest available in the chosen group; Nitro favors generation speed. These are useful search filters. Your software’s rules and failure cases still need their own test. [3](#source-3-pareto-code-router)

```memo-svg
<svg viewBox="0 0 760 301" role="img" aria-label="Two candidates can share a benchmark tier and behave differently in an application">
<text x="24" y="32" font-size="17" fill="var(--cds-text-primary)" font-weight="600" text-anchor="start">A test score leaves your own job untested</text><text x="24" y="55" font-size="12" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">Illustrative candidates. These are not measured model results.</text><rect x="24" y="86" width="324" height="153" rx="6" fill="var(--cds-chart-status-warning)" stroke="var(--cds-chart-status-warning)" stroke-width="1.1" fill-opacity=".09"/><rect x="410" y="86" width="326" height="153" rx="6" fill="var(--cds-chart-categorical-1)" stroke="var(--cds-chart-categorical-1)" stroke-width="1.1" fill-opacity=".08"/><text x="44" y="115" font-size="14" fill="var(--cds-chart-status-warning)" font-weight="600" text-anchor="start">Public coding exam</text><text x="430" y="115" font-size="14" fill="var(--cds-chart-categorical-1)" font-weight="600" text-anchor="start">Your software and its rules</text><text x="44" y="151" font-size="12" fill="var(--cds-text-primary)" font-weight="400" text-anchor="start">Model A qualifies for the group</text><text x="44" y="180" font-size="12" fill="var(--cds-text-primary)" font-weight="400" text-anchor="start">Model B qualifies for the group</text><text x="430" y="151" font-size="12" fill="var(--cds-chart-status-warning)" font-weight="400" text-anchor="start">A fails a rule your software needs</text><text x="430" y="180" font-size="12" fill="var(--cds-chart-categorical-1)" font-weight="400" text-anchor="start">B passes your tests</text><line x1="354" y1="166" x2="401" y2="166" stroke="var(--cds-chart-axis)" stroke-width="1.25"/><path d="M396 162 L401 166 L396 170" fill="none" stroke="var(--cds-chart-axis)" stroke-width="1.25"/><text x="44" y="218" font-size="12" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">Both look suitable on the exam.</text><text x="430" y="218" font-size="12" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">Only one works in this example.</text><text x="24" y="275" font-size="13" fill="var(--cds-text-primary)" font-weight="600" text-anchor="start">The missing measurement is success on the work you will actually run.</text>
</svg>
```

Its `min_coding_score` setting chooses a relative group. **`0.8` does not mean an 80 percent chance of getting your task right.** A model can score well on a general exam and still break your particular application. [3](#source-3-pareto-code-router)

Pareto Code was not tested in this support experiment. This criticism concerns its documented mechanism.

## The model can change after you finish testing

Auto Router can change its choice as rankings or the task change. Pareto Code’s list and relative score bands can also change. Both try to keep conversations on the same model while it remains eligible; that is not a permanent lock. [1](#source-1-auto-router) [3](#source-3-pareto-code-router)

```memo-svg
<svg viewBox="0 0 760 330" role="img" aria-label="An unchanged router setting can select a different model later; a test of the earlier model does not validate the new choice">
<text x="24" y="32" font-size="17" fill="var(--cds-text-primary)" font-weight="600" text-anchor="start">Your setting stays. The model can change.</text>
<text x="24" y="55" font-size="12" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">Illustration of a changing selection; not a measured incident.</text>
<rect x="24" y="86" width="314" height="166" rx="6" fill="var(--cds-chart-categorical-1)" stroke="var(--cds-chart-categorical-1)" stroke-width="1.1" fill-opacity=".10"/>
<rect x="422" y="86" width="314" height="166" rx="6" fill="var(--cds-chart-status-warning)" stroke="var(--cds-chart-status-warning)" stroke-width="1.1" fill-opacity=".12"/>
<text x="44" y="113" font-size="11" fill="var(--cds-chart-categorical-1)" font-weight="400" text-anchor="start">WHEN YOU TESTED</text>
<text x="442" y="113" font-size="11" fill="var(--cds-chart-status-warning)" font-weight="400" text-anchor="start">AFTER THE CANDIDATES CHANGE</text>
<text x="44" y="149" font-size="15" fill="var(--cds-text-primary)" font-weight="600" text-anchor="start">Same router setting</text>
<text x="442" y="149" font-size="15" fill="var(--cds-text-primary)" font-weight="600" text-anchor="start">Same router setting</text>
<text x="44" y="182" font-size="13" fill="var(--cds-text-primary)" font-weight="400" text-anchor="start">Model A handles the work</text>
<text x="442" y="182" font-size="13" fill="var(--cds-text-primary)" font-weight="400" text-anchor="start">Model B handles the work</text>
<text x="44" y="223" font-size="12" fill="var(--cds-chart-categorical-1)" font-weight="400" text-anchor="start">You checked A on your examples.</text>
<text x="442" y="223" font-size="12" fill="var(--cds-chart-status-warning)" font-weight="600" text-anchor="start">Has B passed those checks?</text>
<path d="M351 169H409 M404 165L409 169L404 173" fill="none" stroke="var(--cds-chart-status-warning)" stroke-width="1.25"/>
<text x="24" y="290" font-size="14" fill="var(--cds-text-primary)" font-weight="600" text-anchor="start">A model change creates a new question for your tests.</text>
<text x="24" y="313" font-size="12" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">Keeping a conversation on one model helps; it is not a permanent lock.</text>
</svg>
```

A passing test of one choice is not evidence for a replacement. You need to record changes and test the routing policy across the alternatives it may use. Otherwise, “we tested it last month” may describe a different product.

## A cheaper reply can create a more expensive problem

```memo-svg
<svg viewBox="0 0 760 368" role="img" aria-label="A wrong order can lead to a wrong refund and a convincing confirmation; real savings must count retries and repairs">
<text x="24" y="32" font-size="17" fill="var(--cds-text-primary)" font-weight="600" text-anchor="start">One bad step can spoil the whole job</text>
<text x="24" y="55" font-size="12" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">Illustrative failure chain; no failure rate or repair cost is assumed.</text>
<rect x="24" y="83" width="212" height="92" rx="6" fill="var(--cds-chart-status-critical)" stroke="var(--cds-chart-status-critical)" stroke-width="1.1" fill-opacity=".08"/>
<rect x="274" y="83" width="212" height="92" rx="6" fill="var(--cds-chart-status-critical)" stroke="var(--cds-chart-status-critical)" stroke-width="1.1" fill-opacity=".12"/>
<rect x="524" y="83" width="212" height="92" rx="6" fill="var(--cds-chart-status-warning)" stroke="var(--cds-chart-status-warning)" stroke-width="1.1" fill-opacity=".09"/>
<text x="42" y="114" font-size="14" fill="var(--cds-chart-status-warning)" font-weight="600" text-anchor="start">Wrong order retrieved</text>
<text x="42" y="145" font-size="12" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">The first step is cheap.</text>
<text x="292" y="114" font-size="14" fill="var(--cds-chart-status-warning)" font-weight="600" text-anchor="start">Wrong refund issued</text>
<text x="292" y="145" font-size="12" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">The next step acts on it.</text>
<text x="542" y="114" font-size="14" fill="var(--cds-text-primary)" font-weight="600" text-anchor="start">Polite confirmation</text>
<text x="542" y="145" font-size="12" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">The reply looks successful.</text>
<path d="M240 127H267 M262 123L267 127L262 131" fill="none" stroke="var(--cds-chart-status-critical)" stroke-width="1.25"/>
<path d="M490 127H517 M512 123L517 127L512 131" fill="none" stroke="var(--cds-chart-status-critical)" stroke-width="1.25"/>
<text x="24" y="217" font-size="11" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">WHAT THE BUSINESS STILL PAYS FOR</text>
<rect x="24" y="235" width="712" height="66" rx="6" fill="var(--cds-chart-status-warning)" stroke="var(--cds-chart-status-warning)" stroke-width="1.1" fill-opacity=".10"/>
<text x="380" y="262" font-size="16" fill="var(--cds-text-primary)" font-weight="600" text-anchor="middle">Model calls + retries + human review + repairs</text>
<text x="380" y="285" font-size="12" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="middle">Count testing and monitoring, too.</text>
<text x="24" y="339" font-size="15" fill="var(--cds-text-primary)" font-weight="600" text-anchor="start">Compare the cost of correctly completed jobs.</text>
</svg>
```

A model selector can optimize the price or speed of one request while a later step pays for its mistake. A quick reply can also be followed by a slow retry or a human repair. Those are costs of the job. Neither a low token price nor fast text generation establishes an improvement in the finished outcome.

## What happened when we tested the work

The support agent originally used `gpt-5.5` for every step. **We tested all four Auto Router tiers and OpenMerit’s candidates on the same eight recorded requests at each of the five steps.** The checks compared actual actions, required fields and replies with the original model. Most steps needed seven matching results; reply polishing needed five because the original model was less consistent there. Text comparisons used three AI judging votes. [2](#source-2-openmerit-experiment)

```memo-svg
<svg viewBox="0 0 760 407" role="img" aria-label="The prototype replaced classification and resolution and kept the incumbent on three other steps">
<text x="24" y="32" font-size="17" fill="var(--cds-text-primary)" font-weight="600" text-anchor="start">Two changes. Three decisions to keep the original.</text><text x="24" y="55" font-size="12" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">Choices after testing eight recorded examples per step.</text><text x="24" y="92" font-size="11" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">STEP</text><text x="202" y="92" font-size="11" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">SELECTED MODEL</text><text x="445" y="92" font-size="11" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">MATCHING RESULTS</text><text x="625" y="92" font-size="11" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">STEP COST</text><rect x="14" y="103" width="732" height="44" rx="6" fill="var(--cds-chart-categorical-1)" stroke="var(--cds-chart-categorical-1)" stroke-width="1.1" fill-opacity=".12"/><text x="24" y="130" font-size="13" fill="var(--cds-text-primary)" font-weight="400" text-anchor="start">Classify</text><text x="202" y="130" font-size="13" fill="var(--cds-chart-categorical-1)" font-weight="600" text-anchor="start">gpt-6-luna</text><text x="445" y="130" font-size="12" fill="var(--cds-text-primary)" font-weight="400" text-anchor="start">8 / 8</text><text x="625" y="130" font-size="13" fill="var(--cds-chart-categorical-1)" font-weight="600" text-anchor="start">−98%</text><text x="24" y="179" font-size="13" fill="var(--cds-text-primary)" font-weight="400" text-anchor="start">Order lookup</text><text x="202" y="179" font-size="13" fill="var(--cds-text-primary)" font-weight="400" text-anchor="start">Keep gpt-5.5</text><text x="445" y="179" font-size="12" fill="var(--cds-text-primary)" font-weight="400" text-anchor="start">Best alternative 6 / 8</text><text x="625" y="179" font-size="13" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">Unchanged</text><rect x="14" y="201" width="732" height="44" rx="6" fill="var(--cds-chart-categorical-1)" stroke="var(--cds-chart-categorical-1)" stroke-width="1.1" fill-opacity=".12"/><text x="24" y="228" font-size="13" fill="var(--cds-text-primary)" font-weight="400" text-anchor="start">Resolve</text><text x="202" y="228" font-size="13" fill="var(--cds-chart-categorical-1)" font-weight="600" text-anchor="start">hy3-preview</text><text x="445" y="228" font-size="12" fill="var(--cds-text-primary)" font-weight="400" text-anchor="start">7 / 8</text><text x="625" y="228" font-size="13" fill="var(--cds-chart-categorical-1)" font-weight="600" text-anchor="start">−97%</text><text x="24" y="277" font-size="13" fill="var(--cds-text-primary)" font-weight="400" text-anchor="start">Reply draft</text><text x="202" y="277" font-size="13" fill="var(--cds-text-primary)" font-weight="400" text-anchor="start">Keep gpt-5.5</text><text x="445" y="277" font-size="12" fill="var(--cds-text-primary)" font-weight="400" text-anchor="start">Best alternative 5 / 8</text><text x="625" y="277" font-size="13" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">Unchanged</text><text x="24" y="326" font-size="13" fill="var(--cds-text-primary)" font-weight="400" text-anchor="start">Reply polish</text><text x="202" y="326" font-size="13" fill="var(--cds-text-primary)" font-weight="400" text-anchor="start">Keep gpt-5.5</text><text x="445" y="326" font-size="12" fill="var(--cds-text-primary)" font-weight="400" text-anchor="start">Best alternative 4 / 8</text><text x="625" y="326" font-size="13" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">Unchanged</text><text x="24" y="381" font-size="12" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">Passing a small replay screen is a reason to investigate, not a safety guarantee.</text>
</svg>
```

```memo-svg
<svg viewBox="0 0 760 680" role="img" aria-label="Auto Router was tested on all five steps, with eight recorded requests per step. Low, medium, high and max passed 1, 2, 1 and 2 of five measured replay screens. Their estimated total costs were 5, 45, 71 and 95 percent of baseline. OpenMerit changed two models, kept three and cost 61 percent on the same estimate. A separate ten-ticket run measured baseline cost of 26 dollars 70 and OpenMerit cost of 16 dollars 56 per thousand tickets, with expected actions on nine of ten tickets in each arm.">
<text x="24" y="32" font-size="17" fill="var(--cds-text-primary)" font-weight="600" text-anchor="start">Auto Router was tested on all five steps</text>
<text x="24" y="55" font-size="12" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">Four Auto Router tiers and OpenMerit, compared on recorded work</text>
<text x="24" y="91" font-size="11" fill="var(--cds-text-secondary)" font-weight="600" text-anchor="start">MEASURED STEP TESTS · EIGHT REQUESTS PER STEP</text>
<text x="24" y="115" font-size="11.5" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">Both approaches used the same requests and the same agreement checks.</text>
<text x="214" y="145" font-size="10.5" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">ESTIMATED TOTAL COST</text>
<text x="593" y="145" font-size="10.5" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">MEASURED STEP RESULTS</text>
<line x1="478" y1="156" x2="478" y2="354" stroke="var(--cds-chart-axis)" stroke-width="1" stroke-dasharray="3 4"/>
<text x="24" y="180" font-size="12.5" fill="var(--cds-chart-status-warning)" font-weight="400" text-anchor="start">Auto Router · low</text>
<rect x="214" y="163" width="13.20" height="22" rx="3" fill="var(--cds-chart-status-warning)" fill-opacity="0.8"/>
<text x="497" y="180" font-size="13" fill="var(--cds-chart-status-warning)" font-weight="600" text-anchor="start">5%</text>
<text x="593" y="180" font-size="11.5" fill="var(--cds-chart-status-warning)" font-weight="400" text-anchor="start">1 / 5 steps passed</text>
<text x="24" y="219" font-size="12.5" fill="var(--cds-chart-status-warning)" font-weight="400" text-anchor="start">Auto Router · medium</text>
<rect x="214" y="202" width="118.80" height="22" rx="3" fill="var(--cds-chart-status-warning)" fill-opacity="0.8"/>
<text x="497" y="219" font-size="13" fill="var(--cds-chart-status-warning)" font-weight="600" text-anchor="start">45%</text>
<text x="593" y="219" font-size="11.5" fill="var(--cds-chart-status-warning)" font-weight="400" text-anchor="start">2 / 5 steps passed</text>
<text x="24" y="258" font-size="12.5" fill="var(--cds-chart-status-warning)" font-weight="400" text-anchor="start">Auto Router · high</text>
<rect x="214" y="241" width="187.44" height="22" rx="3" fill="var(--cds-chart-status-warning)" fill-opacity="0.8"/>
<text x="497" y="258" font-size="13" fill="var(--cds-chart-status-warning)" font-weight="600" text-anchor="start">71%</text>
<text x="593" y="258" font-size="11.5" fill="var(--cds-chart-status-warning)" font-weight="400" text-anchor="start">1 / 5 steps passed</text>
<text x="24" y="297" font-size="12.5" fill="var(--cds-chart-status-warning)" font-weight="400" text-anchor="start">Auto Router · max</text>
<rect x="214" y="280" width="250.80" height="22" rx="3" fill="var(--cds-chart-status-warning)" fill-opacity="0.8"/>
<text x="497" y="297" font-size="13" fill="var(--cds-chart-status-warning)" font-weight="600" text-anchor="start">95%</text>
<text x="593" y="297" font-size="11.5" fill="var(--cds-chart-status-warning)" font-weight="400" text-anchor="start">2 / 5 steps passed</text>
<text x="24" y="336" font-size="12.5" fill="var(--cds-chart-categorical-1)" font-weight="600" text-anchor="start">OpenMerit</text>
<rect x="214" y="319" width="161.04" height="22" rx="3" fill="var(--cds-chart-categorical-1)" fill-opacity="1"/>
<text x="497" y="336" font-size="13" fill="var(--cds-chart-categorical-1)" font-weight="600" text-anchor="start">61%</text>
<text x="593" y="336" font-size="11.5" fill="var(--cds-chart-categorical-1)" font-weight="600" text-anchor="start">2 swaps; 3 kept</text>
<line x1="214" y1="362" x2="478" y2="362" stroke="var(--cds-chart-axis)" stroke-width="1"/>
<text x="214" y="381" font-size="10.5" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">0%</text>
<text x="478" y="381" font-size="10.5" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="end">100% · baseline</text>
<text x="24" y="411" font-size="11.5" fill="var(--cds-text-secondary)">Cost bars estimate total spend from measured step costs. Baseline = 100%.</text>
<text x="24" y="433" font-size="11.5" fill="var(--cds-text-secondary)">Step results measure agreement with the original, not independent correctness.</text>
<line x1="24" y1="456" x2="736" y2="456" stroke="var(--cds-chart-grid)" stroke-width="1"/>
<text x="24" y="481" font-size="11" fill="var(--cds-chart-categorical-1)" font-weight="600" text-anchor="start">ADDITIONAL MEASURED CHECK · COMPLETE TEN-TICKET RUN</text>
<text x="214" y="509" font-size="10.5" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">MODEL COST / 1,000 TICKETS</text>
<text x="593" y="509" font-size="10.5" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">EXPECTED ACTIONS</text>
<text x="24" y="540" font-size="13" fill="var(--cds-chart-status-warning)" font-weight="400" text-anchor="start">All gpt-5.5</text>
<rect x="214" y="522" width="264.00" height="22" rx="3" fill="var(--cds-chart-status-warning)" fill-opacity="1"/>
<text x="497" y="540" font-size="14" fill="var(--cds-chart-status-warning)" font-weight="600" text-anchor="start">$26.70</text>
<text x="633" y="540" font-size="13" fill="var(--cds-text-primary)" font-weight="600" text-anchor="start">9 / 10</text>
<text x="24" y="585" font-size="13" fill="var(--cds-chart-categorical-1)" font-weight="600" text-anchor="start">OpenMerit</text>
<rect x="214" y="567" width="163.74" height="22" rx="3" fill="var(--cds-chart-categorical-1)" fill-opacity="1"/>
<text x="497" y="585" font-size="14" fill="var(--cds-chart-categorical-1)" font-weight="600" text-anchor="start">$16.56</text>
<text x="633" y="585" font-size="13" fill="var(--cds-text-primary)" font-weight="600" text-anchor="start">9 / 10</text>
<text x="24" y="619" font-size="11.5" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">Same observed count; ten tickets cannot establish equal reliability.</text>
<line x1="24" y1="640" x2="736" y2="640" stroke="var(--cds-chart-grid)" stroke-width="1"/>
<text x="24" y="665" font-size="11.5" fill="var(--cds-text-secondary)">Model costs only. Search, judging and engineering are excluded.</text>
</svg>
```

In an additional ten-ticket run, OpenMerit’s selected mix reduced measured model-running cost by **38 percent** and performed the expected actions on **9/10 tickets**, matching the original setup’s count. Ten tickets cannot establish equal reliability. We changed two steps and kept the original model on three; refusing an unsupported switch was part of the result.

## The full replay results

**Every Auto Router step below was tested with actual requests.** Read `8/8` as “matched the original on eight of eight examples.” ✓ means it passed that comparison, not that an independent check proved it correct. Negative percentages mean lower model-running cost than `gpt-5.5`. Only the combined workflow cost is estimated from those step results; OpenMerit also has the separate measured 38% saving from its complete run. [2](#source-2-openmerit-experiment)

| Step and pass bar | Auto low `gemini-2.5-flash` | Auto medium `gemini-3.8-flash` | Auto high `glm-5.3` | Auto max `claude-sonnet-5.5` | OpenMerit prototype |
| --- | --- | --- | --- | --- | --- |
| Classify · 7/8 | **8/8 ✓** −95% | **6/8** −64% | **8/8 ✓** −31% | **7/8 ✓** −56% | **8/8 ✓ · −98%** `gpt-6-luna` |
| Order lookup · 7/8 | **4/8** −96% | **5/8** −74% | **6/8** −63% | **4/8** +1% | **Keep original** Best alternative 6/8 |
| Resolve · 7/8 | **6/8** −95% | **8/8 ✓** −68% | **6/8** −41% | **8/8 ✓** 0% | **7/8 ✓ · −97%** `hy3-preview` |
| Reply draft · 7/8 | **1/8** −93% | **8/8 ✓** −32% | **5/8** −60% | **5/8** −31% | **Keep original** Best alternative 5/8 |
| Reply polish · 5/8 | **3/8** −95% | **3/8** +5% | **1/8** +123% | **3/8** +34% | **Keep original** Best alternative 4/8 |
| Alternative steps passing | **1 of 5** | **2 of 5** | **1 of 5** | **2 of 5** | **2 swapped** 3 kept |
| Full-workflow model cost | **−95%** Estimated | **−55%** Estimated | **−29%** Estimated | **−5%** Estimated | **−38%** Measured; −39% on the same estimate |

**None of the four tested Auto Router tiers passed all five steps.** Paying for the max tier still left three steps below the comparison threshold. Choosing a higher price setting did not make the whole workflow pass.

## What each approach takes responsibility for

Adapted from the experiment’s side-by-side table. These are the tested prototype and the documented Auto Router, not every possible routing system. [1](#source-1-auto-router) [2](#source-2-openmerit-experiment)

| Decision | OpenMerit prototype | OpenRouter Auto Router |
| --- | --- | --- |
| What gets a model | Each step, grouped by instructions and available actions | Each request, classified by topic |
| Selection evidence | Public rankings, then tests on that step’s recorded work | Community spend within the topic and price band |
| Check before switching | Compare with the original model on recorded examples | No test of your application in the documented selection rule |
| Approval | A person approves each step’s change | Selection occurs as requests arrive, under configured rules |
| Stability | Fixed until re-approved | Can change with rankings; session stickiness while eligible |
| Model pool | Local proxy, Hugging Face Inference Providers and OpenRouter | OpenRouter catalogue, restrictable with `allowed_models` |
| Setup | Proxy, a logged run and a suggestion step | Set the router model and any required policies |
| Extra evaluation cost | Candidate replays and judge calls | No added router fee; your application testing remains your responsibility |
| Result in this pilot | Two changes; three original models kept; 38% measured model-cost saving | All five assignments changed; 1–2 steps passed per tested tier; 5–95% estimated saving |

## Sometimes the application needs fixing, not a different model

Some models skipped actions when asked to both act and return a rigidly formatted answer in the same step. We separated those demands. The action step returned its decision through `submit_decision`; steps that only returned structured data had no actions to perform. Every tested model received the same change. [2](#source-2-openmerit-experiment)

```memo-svg
<svg viewBox="0 0 760 378" role="img" aria-label="Separating JSON output and tools improved three candidate replay scores while baseline tool behavior stayed unchanged">
<text x="24" y="32" font-size="17" fill="var(--cds-text-primary)" font-weight="600" text-anchor="start">Fix the instructions, then compare the models</text><text x="24" y="55" font-size="12" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">Every tested model received the same application change.</text><rect x="24" y="79" width="334" height="78" rx="6" fill="var(--cds-chart-status-warning)" stroke="var(--cds-chart-status-warning)" stroke-width="1.1" fill-opacity=".10"/><rect x="402" y="79" width="334" height="78" rx="6" fill="var(--cds-chart-status-good)" stroke="var(--cds-chart-status-good)" stroke-width="1.1" fill-opacity=".12"/><text x="44" y="105" font-size="11" fill="var(--cds-chart-status-warning)" font-weight="400" text-anchor="start">BEFORE</text><text x="44" y="134" font-size="13" fill="var(--cds-text-primary)" font-weight="400" text-anchor="start">Act and format the answer in one step</text><text x="422" y="105" font-size="11" fill="var(--cds-chart-status-good)" font-weight="400" text-anchor="start">AFTER</text><text x="422" y="127" font-size="13" fill="var(--cds-chart-categorical-1)" font-weight="400" text-anchor="start">The action step returns its decision.</text><text x="422" y="146" font-size="12" fill="var(--cds-chart-categorical-1)" font-weight="400" text-anchor="start">Formatting-only steps do not act.</text><text x="24" y="193" font-size="11" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">MATCHING RESULTS</text><text x="537" y="193" font-size="11" fill="var(--cds-chart-status-warning)" font-weight="400" text-anchor="start">BEFORE</text><text x="651" y="193" font-size="11" fill="var(--cds-chart-status-good)" font-weight="400" text-anchor="start">AFTER</text><text x="24" y="224" font-size="13" fill="var(--cds-text-primary)" font-weight="400" text-anchor="start">hy3-preview · resolve</text><text x="537" y="224" font-size="14" fill="var(--cds-text-primary)" font-weight="400" text-anchor="start">5 / 8</text><line x1="595" y1="219" x2="633" y2="219" stroke="var(--cds-chart-axis)" stroke-width="1.25"/><text x="651" y="224" font-size="14" fill="var(--cds-chart-categorical-1)" font-weight="600" text-anchor="start">7 / 8</text><text x="24" y="263" font-size="13" fill="var(--cds-text-primary)" font-weight="400" text-anchor="start">Auto medium · resolve</text><text x="537" y="263" font-size="14" fill="var(--cds-text-primary)" font-weight="400" text-anchor="start">3 / 8</text><line x1="595" y1="258" x2="633" y2="258" stroke="var(--cds-chart-axis)" stroke-width="1.25"/><text x="651" y="263" font-size="14" fill="var(--cds-chart-categorical-1)" font-weight="600" text-anchor="start">8 / 8</text><text x="24" y="302" font-size="13" fill="var(--cds-text-primary)" font-weight="400" text-anchor="start">Auto medium · reply draft</text><text x="537" y="302" font-size="14" fill="var(--cds-text-primary)" font-weight="400" text-anchor="start">4 / 8</text><line x1="595" y1="297" x2="633" y2="297" stroke="var(--cds-chart-axis)" stroke-width="1.25"/><text x="651" y="302" font-size="14" fill="var(--cds-chart-categorical-1)" font-weight="600" text-anchor="start">8 / 8</text><line x1="24" y1="324" x2="736" y2="324" stroke="var(--cds-chart-axis)" stroke-width="1.25"/><text x="24" y="352" font-size="12" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">The original setup performed the expected actions on 9 / 10 tickets in both runs.</text>
</svg>
```

Several models improved, including router-selected ones. Changing the instructions solved something that changing the model alone had not. A router that only chooses who receives the same request cannot make that application edit.

Lynkr separately reports altered tool instructions, lost output-format requirements and differences between hosting services. Those are its observations, not extra OpenMerit results. [4](#source-4-lynkr) OpenRouter offers controls for hosting services and supported settings. These can prevent known incompatibilities; they do not prove a refund will be correct. [5](#source-5-provider-routing)

## Learning to choose still depends on what you measure

Not Diamond documents training automatic selection on your examples, candidate answers and scores. [6](#source-6-custom-routing) Automatic routing is not inherently impossible. But this approach requires the application evidence that a plug-in selection setting does not create.

If the score rewards “I issued the refund” without checking the refund, the router learns the wrong lesson. It also needs difficult examples and tests on fresh work. These obligations apply to OpenMerit too. **Automation can carry out a decision supported by evidence. It cannot stand in for the evidence.**

## What this pilot establishes

- **Small sample, imperfect checks.** Both approaches have measured results on eight examples per step. The baseline and OpenMerit also have a ten-ticket complete run. Matching the original answer does not prove correctness. Our chosen resolution model still mishandled one ticket.
- **Cost and scope.** The Auto Router step results are measured; its combined costs are estimates. Some tiers were cheaper on that estimate. A complete-run comparison of accuracy and time remains to be done. Testing and engineering costs are excluded.
- **An incomplete search.** Our ten-candidate limit missed `gemini-3.8-flash`, which passed drafting at 8/8 with 32% lower step cost. The approaches considered different model pools. Our search excluded models without a relevant public test score.
- **Four tiers, not the whole category.** `xhigh`, Pareto Code and custom-trained routers were not tested. The reported disagreements include two medium-tier and one max-tier service errors during classification.

The next proof needs fresh tickets, independent checks of actions and rules, complete-workflow comparisons and the cost of testing. OpenMerit has to earn the same evidence we demand from a router.

## The work the router leaves behind

OpenMerit is being built to coordinate tests, model changes and checks of the finished work inside the application. Our pilot tests only part of that process. The responsibility is broader:

```memo-svg
<svg viewBox="0 0 760 418" role="img" aria-label="A proposed evidence and approval lifecycle can use routers or direct APIs as its serving layer">
<text x="24" y="32" font-size="17" fill="var(--cds-text-primary)" font-weight="600" text-anchor="start">The work around the routing decision</text><text x="24" y="55" font-size="12" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">The responsibility OpenMerit is being built to coordinate.</text><rect x="24" y="86" width="160" height="140" rx="6" fill="var(--cds-chart-categorical-1)" stroke="var(--cds-chart-categorical-1)" stroke-width="1.1" fill-opacity=".06"/><text x="38" y="111" font-size="11" fill="var(--cds-chart-categorical-1)" font-weight="400" text-anchor="start">1</text><text x="38" y="139" font-size="13" fill="var(--cds-text-primary)" font-weight="600" text-anchor="start">Define the job</text><text x="38" y="167" font-size="11" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">Examples, rules,</text><text x="38" y="187" font-size="11" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">actions and success checks</text><line x1="188" y1="155" x2="203" y2="155" stroke="var(--cds-chart-categorical-1)" stroke-width="1.25"/><path d="M198 151 L203 155 L198 159" fill="none" stroke="var(--cds-chart-categorical-1)" stroke-width="1.25"/><rect x="208" y="86" width="160" height="140" rx="6" fill="var(--cds-chart-categorical-1)" stroke="var(--cds-chart-categorical-1)" stroke-width="1.1" fill-opacity=".11"/><text x="222" y="111" font-size="11" fill="var(--cds-chart-categorical-1)" font-weight="400" text-anchor="start">2</text><text x="222" y="139" font-size="13" fill="var(--cds-text-primary)" font-weight="600" text-anchor="start">Compare candidates</text><text x="222" y="167" font-size="11" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">Try recorded examples,</text><text x="222" y="187" font-size="11" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">check costs and failures</text><line x1="372" y1="155" x2="387" y2="155" stroke="var(--cds-chart-categorical-1)" stroke-width="1.25"/><path d="M382 151 L387 155 L382 159" fill="none" stroke="var(--cds-chart-categorical-1)" stroke-width="1.25"/><rect x="392" y="86" width="160" height="140" rx="6" fill="var(--cds-chart-categorical-1)" stroke="var(--cds-chart-categorical-1)" stroke-width="1.1" fill-opacity=".07"/><text x="406" y="111" font-size="11" fill="var(--cds-chart-categorical-1)" font-weight="400" text-anchor="start">3</text><text x="406" y="139" font-size="13" fill="var(--cds-text-primary)" font-weight="600" text-anchor="start">Approve a change</text><text x="406" y="167" font-size="11" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">Keep, change,</text><text x="406" y="187" font-size="11" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">or gather more evidence</text><line x1="556" y1="155" x2="571" y2="155" stroke="var(--cds-chart-categorical-1)" stroke-width="1.25"/><path d="M566 151 L571 155 L566 159" fill="none" stroke="var(--cds-chart-categorical-1)" stroke-width="1.25"/><rect x="576" y="86" width="160" height="140" rx="6" fill="var(--cds-chart-status-good)" stroke="var(--cds-chart-status-good)" stroke-width="1.1" fill-opacity=".12"/><text x="590" y="111" font-size="11" fill="var(--cds-chart-status-good)" font-weight="400" text-anchor="start">4</text><text x="590" y="139" font-size="13" fill="var(--cds-text-primary)" font-weight="600" text-anchor="start">Verify the outcome</text><text x="590" y="167" font-size="11" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">Check the whole job,</text><text x="590" y="187" font-size="11" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">keep or undo the change</text><path d="M656 233 L656 259 L104 259 L104 235" fill="none" stroke="var(--cds-chart-categorical-1)" stroke-width="1.25"/><text x="380" y="284" font-size="12" fill="var(--cds-chart-categorical-1)" font-weight="400" text-anchor="middle">Revisit when the work, models or evidence change</text><line x1="24" y1="307" x2="736" y2="307" stroke="var(--cds-chart-axis)" stroke-width="1.25"/><text x="24" y="335" font-size="13" fill="var(--cds-text-primary)" font-weight="600" text-anchor="start">Where requests go</text><text x="24" y="361" font-size="12" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">Direct connections or a router can send work to the approved models.</text><text x="24" y="393" font-size="12" fill="var(--cds-text-secondary)" font-weight="400" text-anchor="start">The pilot tests only part of this process. It does not validate the full lifecycle.</text>
</svg>
```

**Do not use OpenRouter Auto Router or Pareto Code as a substitute for selecting and validating models in your application.** Their documented selection rules leave the central question unanswered: will this choice complete your work?

Apply the same standard to any auto-router: fresh-work results, checks of completed actions, and total cost and time including failures. Record which models ran and keep a way to undo a bad change. Until that evidence exists, do not give it authority to change models for work whose failures matter.

Skipping model selection and calling it “auto” does not make the selection problem disappear. It leaves your customers to discover whether the choice was wrong.

---

## Sources

### Source 1 Auto Router

[OpenRouter Auto Router documentation](https://openrouter.ai/docs/guides/routing/routers/auto-router). Checked October 6, 2026.

### Source 2 OpenMerit experiment

[OpenMerit’s experiment report, Per-call model picks vs OpenRouter Auto Router](https://claude.ai/artifact/M3SM49ThMN6oF2vvw3TNZy#94ecb202-f79c.mv1fpw7v8ga.9652). October 6, 2026. The comparison flow and both tables are adapted from this report. Figures present its results, not a new independent reproduction.

### Source 3 Pareto Code Router

[OpenRouter Pareto Router documentation](https://openrouter.ai/docs/guides/routing/routers/pareto-router) and [model page](https://openrouter.ai/openrouter/pareto-code). Checked October 6, 2026.

### Source 4 Lynkr

Lynkr, “We benchmarked a self-hosted LLM router against openrouter/auto. Auto turned out to be one model.” @LynkrDev, X, October 6, 2026. Supplied text; a direct post permalink was unavailable. Its results are not pooled with ours.

### Source 5 Provider routing

[OpenRouter provider routing documentation](https://openrouter.ai/docs/guides/routing/provider-selection). Checked October 6, 2026.

### Source 6 Custom routing

[Not Diamond’s custom router training guide](https://docs.notdiamond.ai/docs/router-training-quickstart). Checked October 6, 2026. Cited to distinguish routers trained on application evidence from market- and benchmark-based selection; not tested in our experiment.
