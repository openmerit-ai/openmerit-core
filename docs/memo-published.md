# Optimum Inference for All

1 Oct 2026 · Lazim Aslam and Akhil Aryan

An AI agent makes hundreds of small calls to a model, and each one needs the right model. With new models arriving every week, keeping up gets harder every month.

---

## A choice made once, in a world that changes weekly

An engineer builds an agent, picks a model for each of its steps, gets it working and ships it. After that, new models come out every few weeks, some better, some far cheaper. The agent changes too. New features add instructions, the people using it bring new kinds of requests, volume grows. Yet each step keeps the model it was given on day one, until someone has the time and the evidence to reconsider it, and that time rarely comes.

```memo-svg
<svg viewBox="0 0 760 350" role="img" aria-label="The model picked at launch stays put while better options keep arriving" font-size="13">
<text x="24" y="30" font-size="15" font-weight="600" fill="var(--cds-text-primary)">The model picked at launch stays put while better options keep arriving</text>
<text x="24" y="52" font-size="11.5" fill="var(--cds-text-secondary)">One step in a product over six months</text>
<g>
<line x1="72" x2="700" y1="110" y2="110" stroke="var(--cds-chart-grid)">
</line>
<line x1="72" x2="700" y1="170" y2="170" stroke="var(--cds-chart-grid)">
</line>
<line x1="72" x2="700" y1="230" y2="230" stroke="var(--cds-chart-grid)">
</line>
<line x1="72" x2="700" y1="262" y2="262" stroke="var(--cds-chart-axis)" stroke-width="1.25">
</line>
</g>
<g>
<path d="M72 110 L700 110 L700 226 L540 226 L540 190 L340 190 L340 150 L190 150 L190 110 Z" fill="var(--cds-chart-status-warning)" fill-opacity="0.12">
</path>
<text x="440" y="140" text-anchor="middle" font-weight="600" fill="var(--cds-text-primary)">The gap few teams measure</text>
</g>
<g>
<path d="M72 110 L700 110" fill="none" stroke="var(--cds-chart-status-warning)" stroke-width="3" stroke-linecap="round">
</path>
<circle cx="72" cy="110" r="6" fill="var(--cds-chart-status-warning)">
</circle>
<text x="84" y="98" font-size="12" font-weight="600" fill="var(--cds-text-primary)">Model picked at launch</text>
<text x="700" y="98" text-anchor="end" font-size="12" fill="var(--cds-text-secondary)">What you pay stays unchanged</text>
</g>
<g>
<path d="M72 110 L190 110 L190 150 L340 150 L340 190 L540 190 L540 226 L700 226" fill="none" stroke="var(--cds-chart-categorical-1)" stroke-width="3" stroke-linejoin="round">
</path>
<text x="700" y="248" text-anchor="end" font-size="12" font-weight="600" fill="var(--cds-text-primary)">The best option for this step</text>
</g>
<g>
<circle cx="96" cy="290" r="4" fill="var(--cds-text-secondary)" fill-opacity="0.45">
</circle>
<circle cx="143" cy="290" r="4" fill="var(--cds-text-secondary)" fill-opacity="0.45">
</circle>
<circle cx="190" cy="290" r="6" fill="var(--cds-chart-categorical-1)" fill-opacity="1">
</circle>
<circle cx="237" cy="290" r="4" fill="var(--cds-text-secondary)" fill-opacity="0.45">
</circle>
<circle cx="290" cy="290" r="4" fill="var(--cds-text-secondary)" fill-opacity="0.45">
</circle>
<circle cx="340" cy="290" r="6" fill="var(--cds-chart-categorical-1)" fill-opacity="1">
</circle>
<circle cx="390" cy="290" r="4" fill="var(--cds-text-secondary)" fill-opacity="0.45">
</circle>
<circle cx="440" cy="290" r="4" fill="var(--cds-text-secondary)" fill-opacity="0.45">
</circle>
<circle cx="490" cy="290" r="4" fill="var(--cds-text-secondary)" fill-opacity="0.45">
</circle>
<circle cx="540" cy="290" r="6" fill="var(--cds-chart-categorical-1)" fill-opacity="1">
</circle>
<circle cx="590" cy="290" r="4" fill="var(--cds-text-secondary)" fill-opacity="0.45">
</circle>
<circle cx="640" cy="290" r="4" fill="var(--cds-text-secondary)" fill-opacity="0.45">
</circle>
<circle cx="690" cy="290" r="4" fill="var(--cds-text-secondary)" fill-opacity="0.45">
</circle>
<line x1="190" x2="190" y1="264" y2="282" stroke="var(--cds-chart-categorical-1)" stroke-dasharray="2 3">
</line>
<line x1="340" x2="340" y1="264" y2="282" stroke="var(--cds-chart-categorical-1)" stroke-dasharray="2 3">
</line>
<line x1="540" x2="540" y1="264" y2="282" stroke="var(--cds-chart-categorical-1)" stroke-dasharray="2 3">
</line>
</g>
<g>
<text x="72" y="316" font-size="11.5" fill="var(--cds-text-secondary)">Launch</text>
<text x="390" y="316" text-anchor="middle" font-size="11.5" fill="var(--cds-text-secondary)">Month 3</text>
<text x="700" y="316" text-anchor="end" font-size="11.5" fill="var(--cds-text-secondary)">Month 6</text>
<text x="44" y="186" text-anchor="middle" font-size="11.5" fill="var(--cds-text-secondary)" transform="rotate(-90 44 186)">Cost per finished job</text>
</g>
<g>
<circle cx="80" cy="338" r="4" fill="var(--cds-text-secondary)" fill-opacity="0.45">
</circle>
<text x="92" y="342" font-size="11.5" fill="var(--cds-text-secondary)">A new model is released</text>
<circle cx="276" cy="338" r="5" fill="var(--cds-chart-categorical-1)">
</circle>
<text x="288" y="342" font-size="11.5" fill="var(--cds-text-secondary)">One that could do this step better or for less</text>
</g>
</svg>
```

Few teams go back to it, because going back is a project. Someone has to pull a sample of real work, run it through the alternatives, score the results against the team's own tests, check each new model is allowed under the data rules, and then do it all again for the next step. So the choice stays, and the gap in the chart above grows, mostly unmeasured.

```memo-svg
<svg viewBox="0 0 760 268" role="img" aria-label="Going back is a project, repeated for every step" font-size="11.5">
<defs>
<marker id="gb-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
<path d="M0 0L10 5L0 10z" fill="var(--cds-chart-axis)">
</path>
</marker>
<marker id="gb-arrow-acc" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
<path d="M0 0L10 5L0 10z" fill="var(--cds-chart-categorical-1)">
</path>
</marker>
</defs>
<text x="24" y="30" font-size="15" font-weight="600" fill="var(--cds-text-primary)">Going back is a project, repeated for every step</text>
<text x="24" y="50" font-size="11.5" fill="var(--cds-text-secondary)">An illustrative example</text>
<g>
<rect x="24" y="88" width="158" height="104" rx="8" fill="none" stroke="var(--cds-chart-axis)" stroke-width="1.25">
</rect>
<text x="24" y="78" fill="var(--cds-text-secondary)">01</text>
<text x="103" y="114" text-anchor="middle" font-size="12" font-weight="600" fill="var(--cds-text-primary)">Candidate review</text>
<text x="103" y="136" text-anchor="middle" fill="var(--cds-text-secondary)">A new model or new</text>
<text x="103" y="152" text-anchor="middle" fill="var(--cds-text-secondary)">evidence suggests</text>
<text x="103" y="168" text-anchor="middle" fill="var(--cds-text-secondary)">room to improve</text>
</g>
<g>
<rect x="206" y="88" width="158" height="104" rx="8" fill="none" stroke="var(--cds-chart-axis)" stroke-width="1.25">
</rect>
<text x="206" y="78" fill="var(--cds-text-secondary)">02</text>
<text x="285" y="114" text-anchor="middle" font-size="12" font-weight="600" fill="var(--cds-text-primary)">Task evaluation</text>
<text x="285" y="136" text-anchor="middle" fill="var(--cds-text-secondary)">Check allowed models,</text>
<text x="285" y="152" text-anchor="middle" fill="var(--cds-text-secondary)">prompts, tool calls</text>
<text x="285" y="168" text-anchor="middle" fill="var(--cds-text-secondary)">and existing evals</text>
</g>
<g>
<rect x="388" y="88" width="158" height="104" rx="8" fill="none" stroke="var(--cds-chart-axis)" stroke-width="1.25">
</rect>
<text x="388" y="78" fill="var(--cds-text-secondary)">03</text>
<text x="467" y="114" text-anchor="middle" font-size="12" font-weight="600" fill="var(--cds-text-primary)">Workflow verification</text>
<text x="467" y="136" text-anchor="middle" fill="var(--cds-text-secondary)">Test steps together,</text>
<text x="467" y="152" text-anchor="middle" fill="var(--cds-text-secondary)">including failures</text>
<text x="467" y="168" text-anchor="middle" fill="var(--cds-text-secondary)">and human fixes</text>
</g>
<g>
<rect x="570" y="88" width="158" height="104" rx="8" fill="none" stroke="var(--cds-chart-axis)" stroke-width="1.25">
</rect>
<text x="570" y="78" fill="var(--cds-text-secondary)">04</text>
<text x="649" y="114" text-anchor="middle" font-size="12" font-weight="600" fill="var(--cds-text-primary)">Controlled rollout</text>
<text x="649" y="136" text-anchor="middle" fill="var(--cds-text-secondary)">Try a small share of</text>
<text x="649" y="152" text-anchor="middle" fill="var(--cds-text-secondary)">cases, then check</text>
<text x="649" y="168" text-anchor="middle" fill="var(--cds-text-secondary)">the gain holds</text>
</g>
<g fill="none" stroke="var(--cds-chart-axis)" stroke-width="1.25">
<path d="M182 140 H204" marker-end="url(#gb-arrow)">
</path>
<path d="M364 140 H386" marker-end="url(#gb-arrow)">
</path>
<path d="M546 140 H568" marker-end="url(#gb-arrow)">
</path>
</g>
<g>
<path d="M649 192 V218 H103 V194" fill="none" stroke="var(--cds-chart-categorical-1)" stroke-width="1.5" marker-end="url(#gb-arrow-acc)">
</path>
<text x="376" y="244" text-anchor="middle" fill="var(--cds-chart-categorical-1)">Repeat when new models or evidence justify another comparison</text>
</g>
</svg>
```

**As a system develops, its inference choices should develop with it.** We're building OpenMerit to make that happen with open-source infrastructure that sits inside a company's own software, assesses the models it is allowed to use on the work it actually does, assigns the right one to each step, and keeps checking as the work and the models change.

```memo-svg
<svg viewBox="0 0 760 350" role="img" aria-label="With OpenMerit, what you pay follows the best option down" font-size="13">
<text x="24" y="30" font-size="15" font-weight="600" fill="var(--cds-text-primary)">With OpenMerit, what you pay follows the best option down</text>
<text x="24" y="52" font-size="11.5" fill="var(--cds-text-secondary)">The same step over the same six months, with each new option tested and switched to when it passes</text>
<g>
<line x1="72" x2="700" y1="110" y2="110" stroke="var(--cds-chart-grid)">
</line>
<line x1="72" x2="700" y1="170" y2="170" stroke="var(--cds-chart-grid)">
</line>
<line x1="72" x2="700" y1="230" y2="230" stroke="var(--cds-chart-grid)">
</line>
<line x1="72" x2="700" y1="262" y2="262" stroke="var(--cds-chart-axis)" stroke-width="1.25">
</line>
</g>
<g>
<rect x="190" y="110" width="22" height="40" fill="var(--cds-chart-status-warning)" fill-opacity="0.18">
</rect>
<rect x="340" y="150" width="22" height="40" fill="var(--cds-chart-status-warning)" fill-opacity="0.18">
</rect>
<rect x="540" y="190" width="22" height="36" fill="var(--cds-chart-status-warning)" fill-opacity="0.18">
</rect>
</g>
<g>
<path d="M72 110 L190 110 L190 150 L340 150 L340 190 L540 190 L540 226 L700 226" fill="none" stroke="var(--cds-chart-categorical-1)" stroke-width="2" stroke-dasharray="5 4">
</path>
<text x="700" y="248" text-anchor="end" font-size="12" fill="var(--cds-text-secondary)">The best option for this step</text>
</g>
<g>
<path d="M72 110 L212 110 L212 150 L362 150 L362 190 L562 190 L562 226 L700 226" fill="none" stroke="var(--cds-chart-status-good)" stroke-width="3" stroke-linejoin="round">
</path>
<circle cx="72" cy="110" r="6" fill="var(--cds-chart-status-good)">
</circle>
<circle cx="212" cy="130" r="8" fill="var(--cds-chart-status-good)">
</circle>
<circle cx="362" cy="170" r="8" fill="var(--cds-chart-status-good)">
</circle>
<circle cx="562" cy="208" r="8" fill="var(--cds-chart-status-good)">
</circle>
<text x="84" y="98" font-size="12" font-weight="600" fill="var(--cds-text-primary)">What you pay with OpenMerit</text>
<text x="226" y="134" font-size="11.5" fill="var(--cds-text-secondary)">tested, switched</text>
<text x="376" y="174" font-size="11.5" fill="var(--cds-text-secondary)">tested, switched</text>
<text x="576" y="212" font-size="11.5" fill="var(--cds-text-secondary)">tested, switched</text>
</g>
<g>
<circle cx="96" cy="290" r="4" fill="var(--cds-text-secondary)" fill-opacity="0.45">
</circle>
<circle cx="143" cy="290" r="4" fill="var(--cds-text-secondary)" fill-opacity="0.45">
</circle>
<circle cx="190" cy="290" r="6" fill="var(--cds-chart-categorical-1)" fill-opacity="1">
</circle>
<circle cx="237" cy="290" r="4" fill="var(--cds-text-secondary)" fill-opacity="0.45">
</circle>
<circle cx="290" cy="290" r="4" fill="var(--cds-text-secondary)" fill-opacity="0.45">
</circle>
<circle cx="340" cy="290" r="6" fill="var(--cds-chart-categorical-1)" fill-opacity="1">
</circle>
<circle cx="390" cy="290" r="4" fill="var(--cds-text-secondary)" fill-opacity="0.45">
</circle>
<circle cx="440" cy="290" r="4" fill="var(--cds-text-secondary)" fill-opacity="0.45">
</circle>
<circle cx="490" cy="290" r="4" fill="var(--cds-text-secondary)" fill-opacity="0.45">
</circle>
<circle cx="540" cy="290" r="6" fill="var(--cds-chart-categorical-1)" fill-opacity="1">
</circle>
<circle cx="590" cy="290" r="4" fill="var(--cds-text-secondary)" fill-opacity="0.45">
</circle>
<circle cx="640" cy="290" r="4" fill="var(--cds-text-secondary)" fill-opacity="0.45">
</circle>
<circle cx="690" cy="290" r="4" fill="var(--cds-text-secondary)" fill-opacity="0.45">
</circle>
<line x1="190" x2="190" y1="264" y2="282" stroke="var(--cds-chart-categorical-1)" stroke-dasharray="2 3">
</line>
<line x1="340" x2="340" y1="264" y2="282" stroke="var(--cds-chart-categorical-1)" stroke-dasharray="2 3">
</line>
<line x1="540" x2="540" y1="264" y2="282" stroke="var(--cds-chart-categorical-1)" stroke-dasharray="2 3">
</line>
</g>
<g>
<text x="72" y="316" font-size="11.5" fill="var(--cds-text-secondary)">Launch</text>
<text x="390" y="316" text-anchor="middle" font-size="11.5" fill="var(--cds-text-secondary)">Month 3</text>
<text x="700" y="316" text-anchor="end" font-size="11.5" fill="var(--cds-text-secondary)">Month 6</text>
<text x="44" y="186" text-anchor="middle" font-size="11.5" fill="var(--cds-text-secondary)" transform="rotate(-90 44 186)">Cost per finished job</text>
</g>
<g>
<circle cx="80" cy="338" r="4" fill="var(--cds-text-secondary)" fill-opacity="0.45">
</circle>
<text x="92" y="342" font-size="11.5" fill="var(--cds-text-secondary)">A new model is released</text>
<circle cx="276" cy="338" r="5" fill="var(--cds-chart-categorical-1)">
</circle>
<text x="288" y="342" font-size="11.5" fill="var(--cds-text-secondary)">One that could do this step better or for less</text>
<rect x="560" y="333" width="12" height="10" fill="var(--cds-chart-status-warning)" fill-opacity="0.3">
</rect>
<text x="578" y="342" font-size="11.5" fill="var(--cds-text-secondary)">Time to test</text>
</g>
</svg>
```

This is the same step over the same six months. With OpenMerit, the gap shrinks to the time it takes to test each new option.

### Our mission is optimum inference for all

Most effort goes into better models and more compute. We think there's as much to gain from helping working systems use what's already available. A stronger model can make an unreliable task useful; a smaller one can make a workflow affordable across a whole business. Our mission is optimum inference for all. That means more useful work from the intelligence and compute available to us.

## Why this needs solving

I have seen this up close on AI projects inside large companies. When an AI project has to justify its cost, someone is asked to optimise the model choice so the work gets done within budget. They pick the model that fits and move on. At best this happens for one task, occasionally for one agent, rarely for everything the company runs. The choice seldom has an owner afterwards, and it's rarely revisited when new models arrive or the task changes.

It is hard even for teams that try. Many still struggle to test their AI well (to run “evals”), and many stay on a default expensive model. Even with good tests, swapping out a model that works is a leap of faith, and in an organisation running hundreds of agents in production, few people want to be the one who made that call. One engineering leader in exactly that position put it this way.

> “People want to forget about model selection as much as they want to forget about evals. They just want things to work, and maybe an audit trail they can open from time to time to reassure themselves that yes, it works.”

We're building model choices that teams rarely have to think about, with a record anyone can open to check that it works. Most teams shouldn't have to build that themselves.

## The right model is a moving target

Switching sounds simple. In practice, seven things get in the way.

1. **There are too many models to keep up with.** Dozens of notable new models arrive every year[¹](https://hai.stanford.edu/ai-index/2026-ai-index-report), and OpenRouter alone lists more than 400[²](https://stripe.com/newsroom/news/stripe-agrees-to-acquire-openrouter). Checking them competes with shipping features, and features usually win. Only about one team in ten switched model provider last year[³](https://menlovc.com/perspective/2025-mid-year-llm-market-update/).

2. **Most teams default to the best.** A wrong answer in front of a customer is costly, so the top model often gets used everywhere, even where one at a tenth of the price would do[⁴](https://platform.claude.com/docs/en/about-claude/pricing).

3. **Cheap per answer isn't cheap overall.** Model A costs $1 an answer and is almost always right. Model B costs 10 cents but is wrong one time in five, and each wrong answer means a retry or a person stepping in, which costs far more than the model. Count those, and B can cost more than A. So compare the cost of the finished job, not the price per answer.

4. **You rarely swap just the model.** The instructions, tools and output format were all tuned for it. Change the model and you have to retest the lot.

5. **Steps depend on each other.** Changing the model at one step or task changes what every step after it receives. A model that summarises a call more briefly, for example, can leave the next step without the detail it needs to draft a good reply.

6. **Old test results go out of date.** The test that picked a model three months ago was run on the work as it was then. The instructions, the requests and the models have all changed since, so that result no longer tells you much.

7. **Cost is only one of many rules.** Where data may go, and what has to run on your own servers, narrow the choice. So does speed, when an answer is needed in under a second, and so does the hardware on hand. The right model is the best one that fits every rule at once.

Put those together and it's no surprise that the model picked on day one is usually still there a year later, whatever it costs.

## A fast-growing bill, and a wide gap inside it

The bill is growing fast. Companies spent $37B on generative AI in 2025, three times the year before[⁵](https://menlovc.com/perspective/2025-the-state-of-generative-ai-in-the-enterprise/), and large companies expect their spend on models to grow about 65% in 2026[⁶](https://a16z.com/leaders-gainers-and-unexpected-winners-in-the-enterprise-ai-arms-race/). The gap between a good choice and a default one is large.

In a 2024 study, sending each request to the right model cut cost by more than 85% on one benchmark while keeping 95% of the quality, and by 35–45% on others[⁷](https://www.lmsys.org/blog/2024-07-01-routellm/).

```memo-svg
<svg viewBox="0 0 760 236" role="img" aria-label="Same work, two bills. Routing each request well cut cost by over 85%" font-size="13">
<text x="24" y="30" font-size="15" font-weight="600" fill="var(--cds-text-primary)">Same work, two bills. Routing each request well cut cost by over 85%</text>
<text x="24" y="52" font-size="11.5" fill="var(--cds-text-secondary)">Cost of the same workload, top model = 100 (RouteLLM study, MT Bench benchmark, 2024)</text>
<text x="636" y="80" font-size="11.5" font-weight="600" fill="var(--cds-text-secondary)">Quality kept</text>
<g>
<text x="210" y="115" text-anchor="end" font-weight="600" fill="var(--cds-text-primary)">Top model for everything</text>
<rect x="224" y="92" width="380" height="36" rx="6" fill="var(--cds-chart-muted)">
<title>Top model for everything, 100</title>
</rect>
<text x="236" y="115" font-weight="600" fill="var(--cds-text-primary)">100</text>
<text x="636" y="115" font-weight="600" fill="var(--cds-text-primary)">100%</text>
</g>
<g>
<text x="210" y="175" text-anchor="end" font-weight="600" fill="var(--cds-chart-categorical-1)">Right model per request</text>
<rect x="224" y="152" width="57" height="36" rx="6" fill="var(--cds-chart-categorical-1)">
<title>Right model per request, 15</title>
</rect>
<rect x="285" y="152" width="319" height="36" rx="6" fill="none" stroke="var(--cds-chart-status-good)" stroke-width="1.5" stroke-dasharray="5 4">
</rect>
<text x="234" y="175" font-weight="600" fill="var(--cds-text-inverse)">15</text>
<text x="442.5" y="175" text-anchor="middle" font-weight="600" fill="var(--cds-chart-status-good)">85 saved</text>
<text x="636" y="175" font-weight="600" fill="var(--cds-text-primary)">95%</text>
</g>
</svg>
```

**The gap is likely to grow.** We believe many of today's prices, especially flat-rate subscriptions, sit below what the compute costs, as labs compete to win users. When prices move closer to cost, or the next top model launches at a higher price, the distance between the default choice and the right one widens.

```memo-svg
<svg viewBox="0 0 760 320" role="img" aria-label="The gap widens from both sides" font-size="13">
<text x="24" y="30" font-size="15" font-weight="600" fill="var(--cds-text-primary)">The gap widens from both sides</text>
<text x="24" y="52" font-size="11.5" fill="var(--cds-text-secondary)">Illustration of our view, not measured data</text>
<g>
<line x1="72" x2="700" y1="100" y2="100" stroke="var(--cds-chart-grid)">
</line>
<line x1="72" x2="700" y1="160" y2="160" stroke="var(--cds-chart-grid)">
</line>
<line x1="72" x2="700" y1="220" y2="220" stroke="var(--cds-chart-grid)">
</line>
<line x1="72" x2="700" y1="262" y2="262" stroke="var(--cds-chart-axis)" stroke-width="1.25">
</line>
</g>
<g>
<path d="M72 150 L330 150 L330 118 L530 118 L530 86 L700 86 L700 232 L430 232 L430 214 L72 214 Z" fill="var(--cds-chart-status-warning)" fill-opacity="0.12">
</path>
<text x="470" y="180" text-anchor="middle" font-weight="600" fill="var(--cds-text-primary)">The gap OpenMerit closes</text>
</g>
<g>
<path d="M72 150 L330 150 L330 118 L530 118 L530 86 L700 86" fill="none" stroke="var(--cds-chart-status-warning)" stroke-width="3" stroke-linejoin="round">
</path>
<text x="80" y="140" font-size="12" font-weight="600" fill="var(--cds-text-primary)">Top model for everything</text>
</g>
<g>
<path d="M72 214 L430 214 L430 232 L700 232" fill="none" stroke="var(--cds-chart-categorical-1)" stroke-width="3" stroke-linecap="round">
</path>
<text x="80" y="240" font-size="12" font-weight="600" fill="var(--cds-chart-categorical-1)">Right model per request</text>
</g>
<g>
<line x1="330" x2="330" y1="124" y2="238" stroke="var(--cds-chart-status-warning)" stroke-dasharray="3 4">
</line>
<line x1="530" x2="530" y1="92" y2="238" stroke="var(--cds-chart-status-warning)" stroke-dasharray="3 4">
</line>
<text x="338" y="110" font-size="11.5" fill="var(--cds-text-secondary)">Subsidies end</text>
<text x="522" y="78" text-anchor="end" font-size="11.5" fill="var(--cds-text-secondary)">A pricier top model launches</text>
<line x1="430" x2="430" y1="214" y2="262" stroke="var(--cds-chart-categorical-1)" stroke-dasharray="3 4">
</line>
<text x="438" y="254" font-size="11.5" fill="var(--cds-chart-categorical-1)">A cheaper model launches</text>
</g>
<g>
<text x="72" y="284" font-size="11.5" fill="var(--cds-text-secondary)">Today</text>
<text x="700" y="284" text-anchor="end" font-size="11.5" fill="var(--cds-text-secondary)">Later</text>
<text x="44" y="180" text-anchor="middle" font-size="11.5" fill="var(--cds-text-secondary)" transform="rotate(-90 44 180)">Cost of the same work</text>
</g>
</svg>
```

## What teams use today

Teams that want model choice handled for them today usually reach for a router such as OpenRouter's Auto Router. A router sits outside the company's software. Every request leaves the company, passes through the router, and the router picks a model mostly from the request itself before forwarding it. It takes a percentage of what customers spend through it.

```memo-svg
<svg viewBox="0 0 760 392" role="img" aria-label="Today a router picks each model from outside your software" font-size="13">
<defs>
<marker id="rt-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
<path d="M0 0L10 5L0 10z" fill="var(--cds-chart-axis)">
</path>
</marker>
</defs>
<text x="24" y="30" font-size="15" font-weight="600" fill="var(--cds-text-primary)">Today a router picks each model from outside your software</text>
<text x="24" y="52" font-size="11.5" fill="var(--cds-text-secondary)">It sees one request at a time, never sees your test results, and takes a share of what you spend</text>
<g>
<rect x="24" y="72" width="276" height="300" rx="12" fill="none" stroke="var(--cds-chart-axis)" stroke-width="1" stroke-dasharray="5 5">
</rect>
<text x="40" y="92" font-size="11.5" fill="var(--cds-text-secondary)">Inside your company</text>
</g>
<g>
<rect x="40" y="102" width="244" height="176" rx="8" fill="none" stroke="var(--cds-chart-axis)" stroke-width="1.25">
</rect>
<text x="162" y="126" text-anchor="middle" font-weight="600" fill="var(--cds-text-primary)">Your software</text>
<text x="162" y="142" text-anchor="middle" font-size="11.5" fill="var(--cds-text-secondary)">(the harness)</text>
<rect x="56" y="154" width="212" height="32" rx="8" fill="var(--cds-chart-reference-tint)">
</rect>
<rect x="56" y="194" width="212" height="32" rx="8" fill="var(--cds-chart-reference-tint)">
</rect>
<rect x="56" y="234" width="212" height="32" rx="8" fill="var(--cds-chart-reference-tint)">
</rect>
<text x="68" y="174" font-size="12.5" fill="var(--cds-text-primary)">Sort a ticket</text>
<text x="256" y="174" text-anchor="end" font-size="11.5" fill="var(--cds-text-secondary)">sent out</text>
<text x="68" y="214" font-size="12.5" fill="var(--cds-text-primary)">Summarise a call</text>
<text x="256" y="214" text-anchor="end" font-size="11.5" fill="var(--cds-text-secondary)">sent out</text>
<text x="68" y="254" font-size="12.5" fill="var(--cds-text-primary)">Draft a reply</text>
<text x="256" y="254" text-anchor="end" font-size="11.5" fill="var(--cds-text-secondary)">sent out</text>
</g>
<g>
<rect x="40" y="292" width="244" height="64" rx="8" fill="none" stroke="var(--cds-chart-axis)" stroke-width="1.25">
</rect>
<text x="56" y="318" font-weight="600" fill="var(--cds-text-primary)">Observability</text>
<text x="56" y="338" font-size="11.5" fill="var(--cds-text-secondary)">your test scores and human fixes</text>
</g>
<g>
<rect x="392" y="130" width="152" height="112" rx="8" fill="var(--cds-chart-status-warning)" fill-opacity="0.12" stroke="var(--cds-chart-status-warning)" stroke-width="1.5">
</rect>
<text x="468" y="156" text-anchor="middle" font-weight="600" fill="var(--cds-text-primary)">OpenRouter</text>
<text x="468" y="178" text-anchor="middle" font-size="11.5" fill="var(--cds-text-secondary)">picks a model from</text>
<text x="468" y="194" text-anchor="middle" font-size="11.5" fill="var(--cds-text-secondary)">the request itself</text>
<text x="468" y="226" text-anchor="middle" font-size="11.5" font-weight="600" fill="var(--cds-chart-status-warning)">takes a % of spend</text>
</g>
<g>
<rect x="588" y="110" width="148" height="140" rx="8" fill="none" stroke="var(--cds-chart-axis)" stroke-width="1.25">
</rect>
<text x="600" y="134" font-weight="600" fill="var(--cds-text-primary)">Model sellers</text>
<text x="600" y="160" font-size="11.5" fill="var(--cds-text-primary)">Frontier labs</text>
<text x="600" y="182" font-size="11.5" fill="var(--cds-text-primary)">Open-weight clouds</text>
<text x="600" y="204" font-size="11.5" fill="var(--cds-text-primary)">Other providers</text>
</g>
<g fill="none" stroke="var(--cds-chart-axis)" stroke-width="1.25">
<path d="M284 186 H390" marker-end="url(#rt-arrow)">
</path>
<path d="M544 186 H586" marker-end="url(#rt-arrow)">
</path>
<path d="M162 278 V290" marker-end="url(#rt-arrow)">
</path>
</g>
<text x="346" y="160" text-anchor="middle" font-size="11.5" fill="var(--cds-text-secondary)">every request</text>
<text x="346" y="176" text-anchor="middle" font-size="11.5" fill="var(--cds-text-secondary)">and its data</text>
<text x="565" y="178" text-anchor="middle" font-size="11.5" fill="var(--cds-text-secondary)">sends</text>
<g>
<path d="M284 324 H468 V246" fill="none" stroke="var(--cds-chart-axis)" stroke-width="1.25" stroke-dasharray="4 4">
</path>
<g stroke="var(--cds-chart-status-critical)" stroke-width="2">
<line x1="460" y1="277" x2="476" y2="293">
</line>
<line x1="476" y1="277" x2="460" y2="293">
</line>
</g>
<text x="300" y="346" font-size="11.5" font-weight="600" fill="var(--cds-chart-status-critical)">scores and fixes don't reach it</text>
</g>
</svg>
```

A typical router does a different job from OpenMerit, in three ways.

- **It decides before the answer exists.** It sees one request and has to choose in real time. It doesn't know which step of the workflow sent the request, or what happens next. You could send more context with the prompt, but it still has to decide in real time, without trying the alternatives on your work first.

- **It doesn't learn whether it guessed well.** The company's test scores, retries and human fixes don't flow back to it. Wiring scores back isn't enough. To learn what works, you have to replay real work on the alternatives, run the company's own tests and tools, and see what the next steps do with each answer. All of that lives inside the company's software, not in the stream of requests a router sees.

- **It earns more when you spend more.** OpenRouter doesn't mark up tokens, but it takes a percentage of what customers spend, so its business grows when you spend more. Ours is the opposite. We manage your token use so every token does more work. We are paid for better decisions and don't mark up tokens.

Today, little connects the scorecard back to the choice. Observability can show a step is overpaying but isn't built to change it; routers see one request at a time and earn more when you spend more. OpenMerit closes that loop from inside the company's own software.

## How OpenMerit works

OpenMerit works the other way round. Instead of guessing each request from outside, it sits inside your software, next to the steps it looks after, and keeps every model choice under review.

```memo-svg
<svg viewBox="0 0 760 420" role="img" aria-label="OpenMerit closes the loop from inside the harness" font-size="13">
<defs>
<marker id="arch-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
<path d="M0 0L10 5L0 10z" fill="var(--cds-chart-axis)">
</path>
</marker>
<marker id="arch-arrow-om" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
<path d="M0 0L10 5L0 10z" fill="var(--cds-chart-categorical-1)">
</path>
</marker>
</defs>
<text x="24" y="30" font-size="15" font-weight="600" fill="var(--cds-text-primary)">OpenMerit closes the loop from inside the harness</text>
<text x="24" y="52" font-size="11.5" fill="var(--cds-text-secondary)">Grey arrows show how an AI system runs today. Coloured arrows show what OpenMerit adds.</text>
<g>
<rect x="24" y="110" width="136" height="190" rx="8" fill="none" stroke="var(--cds-chart-axis)" stroke-width="1.25">
</rect>
<text x="36" y="134" font-weight="600" fill="var(--cds-text-primary)">Model sellers</text>
<text x="36" y="162" font-size="11.5" fill="var(--cds-text-primary)">Frontier labs</text>
<text x="36" y="186" font-size="11.5" fill="var(--cds-text-primary)">Open-weight models</text>
<text x="36" y="210" font-size="11.5" fill="var(--cds-text-primary)">Your own servers</text>
<text x="36" y="234" font-size="11.5" fill="var(--cds-text-primary)">OpenRouter</text>
<text x="92" y="324" text-anchor="middle" font-size="11.5" fill="var(--cds-text-secondary)">paid per token</text>
</g>
<g>
<rect x="236" y="70" width="288" height="330" rx="12" fill="none" stroke="var(--cds-chart-axis)" stroke-width="1" stroke-dasharray="5 5">
</rect>
<text x="252" y="90" font-size="11.5" fill="var(--cds-text-secondary)">Inside your company</text>
</g>
<g>
<rect x="252" y="100" width="256" height="286" rx="8" fill="none" stroke="var(--cds-chart-axis)" stroke-width="1.25">
</rect>
<text x="380" y="124" text-anchor="middle" font-weight="600" fill="var(--cds-text-primary)">Your software</text>
<text x="380" y="140" text-anchor="middle" font-size="11.5" fill="var(--cds-text-secondary)">(the harness)</text>
<rect x="268" y="150" width="224" height="32" rx="8" fill="var(--cds-chart-reference-tint)" stroke="none">
</rect>
<rect x="268" y="190" width="224" height="32" rx="8" fill="var(--cds-chart-reference-tint)" stroke="none">
</rect>
<rect x="268" y="230" width="224" height="32" rx="8" fill="var(--cds-chart-reference-tint)" stroke="none">
</rect>
<text x="280" y="170" font-size="12.5" fill="var(--cds-text-primary)">Sort a ticket</text>
<text x="480" y="170" text-anchor="end" font-size="11.5" fill="var(--cds-chart-categorical-1)">small model</text>
<text x="280" y="210" font-size="12.5" fill="var(--cds-text-primary)">Summarise a call</text>
<text x="480" y="210" text-anchor="end" font-size="11.5" fill="var(--cds-chart-categorical-1)">open-weight</text>
<text x="280" y="250" font-size="12.5" fill="var(--cds-text-primary)">Draft a reply</text>
<text x="480" y="250" text-anchor="end" font-size="11.5" fill="var(--cds-chart-categorical-1)">frontier</text>
</g>
<g>
<circle cx="380" cy="326" r="36" fill="var(--cds-chart-categorical-1)" fill-opacity="0.12" stroke="var(--cds-chart-categorical-1)" stroke-width="2">
</circle>
<text x="380" y="330" text-anchor="middle" font-size="12" font-weight="600" fill="var(--cds-text-primary)">OpenMerit</text>
</g>
<g>
<rect x="612" y="110" width="124" height="190" rx="8" fill="none" stroke="var(--cds-chart-axis)" stroke-width="1.25">
</rect>
<text x="624" y="134" font-weight="600" fill="var(--cds-text-primary)">Observability</text>
<text x="624" y="162" font-size="11.5" fill="var(--cds-text-primary)">LangSmith</text>
<text x="624" y="186" font-size="11.5" fill="var(--cds-text-primary)">Langfuse</text>
<text x="624" y="210" font-size="11.5" fill="var(--cds-text-primary)">Arize</text>
<text x="624" y="234" font-size="11.5" fill="var(--cds-text-primary)">Braintrust</text>
<text x="674" y="324" text-anchor="middle" font-size="11.5" fill="var(--cds-text-secondary)">sees, doesn't act</text>
</g>
<g fill="none" stroke="var(--cds-chart-axis)" stroke-width="1.25">
<path d="M252 150 H162" marker-end="url(#arch-arrow)">
</path>
<path d="M160 178 H250" marker-end="url(#arch-arrow)">
</path>
<path d="M508 150 H610" marker-end="url(#arch-arrow)">
</path>
</g>
<text x="198" y="142" text-anchor="middle" font-size="11.5" fill="var(--cds-text-secondary)">sends work</text>
<text x="198" y="196" text-anchor="middle" font-size="11.5" fill="var(--cds-text-secondary)">answers</text>
<text x="566" y="142" text-anchor="middle" font-size="11.5" fill="var(--cds-text-secondary)">logs calls</text>
<g fill="none" stroke="var(--cds-chart-categorical-1)" stroke-width="1.5">
<path d="M612 272 L418 318" marker-end="url(#arch-arrow-om)">
</path>
<path d="M344 318 L162 272" marker-end="url(#arch-arrow-om)">
</path>
<path d="M380 290 V266" marker-end="url(#arch-arrow-om)">
</path>
</g>
<text x="572" y="268" text-anchor="middle" font-size="11.5" font-weight="600" fill="var(--cds-chart-categorical-1)">scores</text>
<text x="200" y="268" text-anchor="middle" font-size="11.5" font-weight="600" fill="var(--cds-chart-categorical-1)">compares</text>
<text x="392" y="280" font-size="11.5" font-weight="600" fill="var(--cds-chart-categorical-1)">assigns</text>
</svg>
```

The grey arrows are how the company runs today. OpenMerit adds the olive ones. It reads the scores the company's observability tools already keep, compares the alternatives the company is allowed to use, and assigns a model to each step. It doesn't sit between your software and the model, so if it stops, live work doesn't.

It does this as a loop, every time the work or the models change.

```memo-svg
<svg viewBox="0 0 760 376" role="img" aria-label="OpenMerit keeps every model choice under review" font-size="13">
<defs>
<marker id="loop-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
<path d="M0 0L10 5L0 10z" fill="var(--cds-chart-categorical-1)">
</path>
</marker>
</defs>
<text x="24" y="30" font-size="15" font-weight="600" fill="var(--cds-text-primary)">OpenMerit keeps every model choice under review</text>
<text x="24" y="50" font-size="11.5" fill="var(--cds-text-secondary)">It reassesses when the work, the models or the evidence change</text>
<g fill="none" stroke="var(--cds-chart-categorical-1)" stroke-width="1.5">
<path d="M492 104 Q620 104 620 182" marker-end="url(#loop-arrow)">
</path>
<path d="M620 236 Q620 322 494 322" marker-end="url(#loop-arrow)">
</path>
<path d="M268 322 Q140 322 140 238" marker-end="url(#loop-arrow)">
</path>
<path d="M140 182 Q140 104 266 104" marker-end="url(#loop-arrow)">
</path>
</g>
<g>
<rect x="268" y="78" width="224" height="52" rx="8" fill="none" stroke="var(--cds-chart-axis)" stroke-width="1.25">
</rect>
<text x="380" y="100" text-anchor="middle" font-weight="600" fill="var(--cds-text-primary)">1 · Set the rules</text>
<text x="380" y="118" text-anchor="middle" font-size="11.5" fill="var(--cds-text-secondary)">models, data rules, budgets</text>
</g>
<g>
<rect x="508" y="183" width="224" height="52" rx="8" fill="none" stroke="var(--cds-chart-axis)" stroke-width="1.25">
</rect>
<text x="620" y="205" text-anchor="middle" font-weight="600" fill="var(--cds-text-primary)">2 · Compare on real work</text>
<text x="620" y="223" text-anchor="middle" font-size="11.5" fill="var(--cds-text-secondary)">whole configurations, your tests</text>
</g>
<g>
<rect x="268" y="296" width="224" height="52" rx="8" fill="none" stroke="var(--cds-chart-axis)" stroke-width="1.25">
</rect>
<text x="380" y="318" text-anchor="middle" font-weight="600" fill="var(--cds-text-primary)">3 · Decide</text>
<text x="380" y="336" text-anchor="middle" font-size="11.5" fill="var(--cds-text-secondary)">keep, change, or dig deeper</text>
</g>
<g>
<rect x="28" y="183" width="224" height="52" rx="8" fill="none" stroke="var(--cds-chart-axis)" stroke-width="1.25">
</rect>
<text x="140" y="205" text-anchor="middle" font-weight="600" fill="var(--cds-text-primary)">4 · Verify in production</text>
<text x="140" y="223" text-anchor="middle" font-size="11.5" fill="var(--cds-text-secondary)">keep it, or roll back</text>
</g>
<g>
<circle cx="380" cy="212" r="66" fill="var(--cds-chart-categorical-1)" fill-opacity="0.12" stroke="var(--cds-chart-categorical-1)" stroke-width="2">
</circle>
<text x="380" y="204" text-anchor="middle" font-size="12.5" font-weight="600" fill="var(--cds-text-primary)">Decision history</text>
<text x="380" y="222" text-anchor="middle" font-size="11.5" fill="var(--cds-text-secondary)">what was tested</text>
<text x="380" y="238" text-anchor="middle" font-size="11.5" fill="var(--cds-text-secondary)">and why</text>
</g>
</svg>
```

Every decision is recorded with what was tested, the evidence and the reasoning. It's the audit trail a team can open whenever it wants reassurance that it works.

Take a customer support ticket. With a typical router, the ticket's text goes out to the router, which picks a model in real time, mostly from the wording, and doesn't find out whether the reply was any good. With OpenMerit, the model for the “draft a reply” step was chosen in advance. Several models were tested on last month's real tickets, and the one whose replies agents had to fix least won. The new ticket goes straight to that model, and OpenMerit keeps watching how its replies do.

|  | A typical router | OpenMerit |
| --- | --- | --- |
| **Sits** | Outside, in every request's path | Inside, out of the live path |
| **Decides from** | One request, One session | Your real work and tests |
| **Learns?** | Doesn't hear how it went | Checks each change in production |
| **Paid for** | A share of what you spend | Better decisions, no markup |

Routers are built around selling tokens; OpenMerit is built around making each one count.

## Where OpenMerit fits

To see where OpenMerit fits among today's tools, ask two questions of each. Does it actually decide which model to use, or only report? And does it decide from evidence from your own work, or from general signals?

```memo-svg
<svg viewBox="0 0 760 448" role="img" aria-label="OpenMerit decides using the customer's own workload in production" font-size="13">
<text x="24" y="30" font-size="15" font-weight="600" fill="var(--cds-text-primary)">OpenMerit decides using the customer's own workload in production</text>
<text x="24" y="50" font-size="11.5" fill="var(--cds-text-secondary)">Our view of where each tool sits today</text>
<g>
<rect x="88" y="64" width="318" height="164" rx="10" fill="var(--cds-chart-reference-tint)">
</rect>
<rect x="418" y="64" width="318" height="164" rx="10" fill="var(--cds-chart-categorical-1)" fill-opacity="0.1">
</rect>
<rect x="88" y="240" width="318" height="164" rx="10" fill="var(--cds-chart-reference-tint)">
</rect>
<rect x="418" y="240" width="318" height="164" rx="10" fill="var(--cds-chart-reference-tint)">
</rect>
<text x="100" y="84" font-size="11.5" fill="var(--cds-text-secondary)">Decides, on general signals</text>
<text x="724" y="84" text-anchor="end" font-size="11.5" font-weight="600" fill="var(--cds-chart-categorical-1)">Decides, on your own evidence</text>
<text x="100" y="394" font-size="11.5" fill="var(--cds-text-secondary)">Reports only</text>
<text x="724" y="394" text-anchor="end" font-size="11.5" fill="var(--cds-text-secondary)">Measures your work, Custom Evals and Loops</text>
</g>
<g>
<circle cx="166" cy="118" r="7" fill="var(--cds-chart-status-warning)">
</circle>
<text x="180" y="114" font-size="12.5" font-weight="600" fill="var(--cds-text-primary)">OpenRouter</text>
<text x="180" y="130" font-size="11.5" fill="var(--cds-text-secondary)">Auto Router</text>
</g>
<g>
<circle cx="202" cy="166" r="7" fill="var(--cds-chart-axis)">
</circle>
<text x="216" y="162" font-size="12.5" font-weight="600" fill="var(--cds-text-primary)">The labs</text>
<text x="216" y="178" font-size="11.5" fill="var(--cds-text-secondary)">built around their own models</text>
</g>
<g>
<circle cx="619" cy="340" r="7" fill="var(--cds-chart-axis)">
</circle>
<text x="605" y="336" text-anchor="end" font-size="12.5" font-weight="600" fill="var(--cds-text-primary)">Langfuse · Braintrust</text>
<text x="605" y="352" text-anchor="end" font-size="11.5" fill="var(--cds-text-secondary)">Arize · LangSmith</text>
</g>
<g>
<circle cx="680" cy="122" r="11" fill="var(--cds-chart-categorical-1)">
</circle>
<text x="662" y="127" text-anchor="end" font-size="13" font-weight="600" fill="var(--cds-chart-categorical-1)">OpenMerit</text>
</g>
<g>
<text x="412" y="430" text-anchor="middle" font-size="11.5" fill="var(--cds-text-secondary)">Uses evidence from your own work →</text>
<text x="88" y="430" font-size="11.5" fill="var(--cds-text-secondary)">no</text>
<text x="736" y="430" text-anchor="end" font-size="11.5" fill="var(--cds-text-secondary)">yes</text>
<text x="62" y="234" text-anchor="middle" font-size="11.5" fill="var(--cds-text-secondary)" transform="rotate(-90 62 234)">Makes the model decision →</text>
</g>
</svg>
```

Both OpenRouter and the big labs are moving closer to the harness. OpenRouter launched an Agent SDK for building harnesses in April 2026[⁸](https://openrouter.ai/blog/tutorials/create-agent-harness-with-agent-sdk/), and each lab ships its own agent tools, such as Claude Code[⁹](https://code.claude.com/docs/en/bedrock-vertex) and the OpenAI Agents SDK[¹⁰](https://openai.github.io/openai-agents-python/models/). But both earn more when customers spend more. The labs sell their own models, and OpenRouter takes a percentage of what customers spend[¹¹](https://openrouter.ai/docs/faq), which makes either an awkward judge of when to spend less. Making these decisions well takes someone neutral, paid for better choices rather than more usage. That is why we think OpenMerit needs to exist as its own company.

## Where we start, and how it spreads

We start with engineering and AI teams running repeatable production workflows, where outcomes are measurable, volume is high enough for a better choice to matter, and someone can judge the result. Existing evaluations make the strongest starting point.

```memo-svg
<svg viewBox="0 0 760 290" role="img" aria-label="We start with the first two layers of the decision" font-size="13">
<text x="24" y="30" font-size="15" font-weight="600" fill="var(--cds-text-primary)">We start with the first two layers of the decision</text>
<g>
<rect x="24" y="52" width="712" height="60" rx="8" fill="var(--cds-chart-categorical-1)" fill-opacity="0.12" stroke="var(--cds-chart-categorical-1)" stroke-width="1.5" stroke-dasharray="none">
</rect>
<text x="44" y="88" font-size="18" font-weight="600" fill="var(--cds-chart-categorical-1)">L1</text>
<text x="96" y="78" font-weight="600" fill="var(--cds-text-primary)">Which models are allowed at all</text>
<text x="96" y="96" font-size="11.5" fill="var(--cds-text-secondary)">Security, region, data rules, the hardware on hand. The organisation-wide view.</text>
<text x="716" y="86" text-anchor="end" font-size="11.5" font-weight="600" fill="var(--cds-chart-categorical-1)">First product</text>
</g>
<g>
<rect x="24" y="124" width="712" height="60" rx="8" fill="var(--cds-chart-categorical-1)" fill-opacity="0.12" stroke="var(--cds-chart-categorical-1)" stroke-width="1.5" stroke-dasharray="none">
</rect>
<text x="44" y="160" font-size="18" font-weight="600" fill="var(--cds-chart-categorical-1)">L2</text>
<text x="96" y="150" font-weight="600" fill="var(--cds-text-primary)">The right model for each repeatable step</text>
<text x="96" y="168" font-size="11.5" fill="var(--cds-text-secondary)">Every ticket is sorted, summarised and answered the same way, so each step can be tested on its own.</text>
<text x="716" y="158" text-anchor="end" font-size="11.5" font-weight="600" fill="var(--cds-chart-categorical-1)">First product</text>
</g>
<g>
<rect x="24" y="196" width="712" height="60" rx="8" fill="none" fill-opacity="1" stroke="var(--cds-chart-axis)" stroke-width="1.25" stroke-dasharray="5 5">
</rect>
<text x="44" y="232" font-size="18" font-weight="600" fill="var(--cds-text-secondary)">L3</text>
<text x="96" y="222" font-weight="600" fill="var(--cds-text-primary)">Choices made while an agent works</text>
<text x="96" y="240" font-size="11.5" fill="var(--cds-text-secondary)">An agent revises its plan or starts helpers mid-task and picks their models as it goes.</text>
<text x="716" y="230" text-anchor="end" font-size="11.5" fill="var(--cds-text-secondary)">Research</text>
</g>
</svg>
```

The first product combines **L1**, the organisation-wide view of which models are allowed and where, with **L2**, repeatable workflows. L2 should support a business on its own. **L3**, agents that change their plan and create helpers mid-task, is our longer-term research direction.

The first user is an engineer whose workflow's bill, a regression or a promising new model gives them a reason to revisit the choice. We meet them in three ways.

1. **Through coding agents.** A developer, or their agent, connects one workflow, uses its existing evaluations and asks OpenMerit to investigate. The first useful result arrives without adopting a new evaluation or serving stack.

2. **Through open source.** Engineers adopt what they can read, run locally and remove, without a procurement cycle.

3. **Through the tools teams already use to watch their AI.** When Langfuse or Braintrust shows a step failing or overspending, an integration hands it to OpenMerit to fix, and to keep fixed.

Expansion follows repeated use. Help a team through the next release and they connect a second workflow; over time, shared rules and a common decision history make the platform team the buyer. Coming back to OpenMerit has to be easier than repeating the comparison themselves. We have to earn the second investigation.

## Risks we're weighing

- **Evidence risk.** OpenMerit can only choose as well as the customer can measure. If a team has no reliable way to tell a good answer from a bad one, our comparisons will be too noisy to justify a switch. We start with teams that already run evaluations, and we report "not enough evidence" rather than force a decision.

- **Cost risk.** Testing alternatives costs money. If our testing costs more than better choices save, the customer ends up worse off. We test on samples, only when the work or the models change, and recommend a switch only when the expected saving exceeds the cost of testing.

- **Integration risk.** If applying each recommended change takes engineering work, teams may stop acting on our recommendations. We plan to prove the full loop, from test to applied change, on a small number of integrations before expanding.

- **Retention risk.** If most teams need only one comparison, OpenMerit becomes a one-off audit rather than a system they keep running. We think the pace of model releases, and changes in the work itself, will keep creating reasons to re-test. Our retention depends on that holding.

- **Competitive risk.** A router or an observability tool could add model selection. We think they are unlikely to own it. Routers earn a share of spend and observability tools earn on traces, so neither is paid to lower what customers spend on models. If either changes how it makes money, this risk rises.

We need to prove this on one repeatable workflow, with a baseline the customer trusts, a justified decision to change or keep a model, and follow-through that accounts for the full outcome and our own costs. Then we need to do it again as the work changes.

## Where this goes

Every company is becoming one that runs on models, making millions of model choices a day, and few of them on purpose. We think model choice will follow the path that security and testing took, growing from something a few engineers do when they find the time into a layer most serious companies run. The models and the work keep changing, so there is no final answer to hand over; it has to be a system, and that's what we're building.

**OpenMerit. Optimum inference for all.**

---

## Sources

Numbers in the text point to this list.

1. [Stanford HAI, AI Index 2026](https://hai.stanford.edu/ai-index/2026-ai-index-report)

2. [Stripe agrees to acquire OpenRouter (Aug 2026)](https://stripe.com/newsroom/news/stripe-agrees-to-acquire-openrouter)

3. [Menlo Ventures, Mid-Year LLM Market Update (Jul 2025)](https://menlovc.com/perspective/2025-mid-year-llm-market-update/)

4. [Anthropic API pricing](https://platform.claude.com/docs/en/about-claude/pricing)

5. [Menlo Ventures, State of Generative AI in the Enterprise (Dec 2025)](https://menlovc.com/perspective/2025-the-state-of-generative-ai-in-the-enterprise/)

6. [a16z, enterprise CIO survey (Jan 2026)](https://a16z.com/leaders-gainers-and-unexpected-winners-in-the-enterprise-ai-arms-race/)

7. [LMSYS, RouteLLM (Jul 2024)](https://www.lmsys.org/blog/2024-07-01-routellm/)

8. [OpenRouter, Build your own harness with the Agent SDK (2026)](https://openrouter.ai/blog/tutorials/create-agent-harness-with-agent-sdk/)

9. [Claude Code docs, enterprise deployment on Bedrock and Vertex](https://code.claude.com/docs/en/bedrock-vertex)

10. [OpenAI Agents SDK docs, models and third-party providers](https://openai.github.io/openai-agents-python/models/)

11. [OpenRouter FAQ, pricing and fees](https://openrouter.ai/docs/faq)

Tools shown in the positioning map include [Langfuse](https://langfuse.com/docs/evaluation/experiments/compare-experiments) · [Braintrust](https://www.braintrust.dev/docs/evaluate).

## Additional reading

- [The Shift from Models to Compound AI Systems](https://bair.berkeley.edu/blog/2024/02/18/compound-ai-systems/), Zaharia et al., BAIR (Feb 2024)

- [Optimas. Optimizing Compound AI Systems with Globally Aligned Local Rewards](https://optimas.stanford.edu/), Wu et al. (Feb 2026)

- [AI Agents That Matter](https://arxiv.org/abs/2407.01502), Kapoor et al. (Jul 2024)

- [Scaling Managed Agents. Decoupling the brain from the hands](https://www.anthropic.com/engineering/managed-agents), Anthropic (Apr 2026)

- [Continually improving our agent harness](https://cursor.com/blog/continually-improving-agent-harness), Cursor (Apr 2026)
