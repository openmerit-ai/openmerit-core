# Optimum Inference For All

*Lazim*

How can we accelerate the distribution of intelligence?

Building and deploying more models and improving the compute landscape is where most of the energy being spent right now. I have another, less explored direction in my mind, which I call, the optimum inference problem.

I see a substantial part of what limits autonomous systems is how the models are selected and assessed throughout their lifecycle. It's a harness-level infrastructure concern.

#### Does this need to get solved?

In companies that I had the privilege of working with, I have built or maintained or used a rudimentary version of this. When budget constraints strangled the roadmap, teams scrambled their way out by building something enough to justify why they need to pay y amount of money to solve x task. This was never a maintained system nor it was ever prioritised because it was seen as an optional optimisation issue and overlooked the power it had over the dissemination of intelligence inside the org and the products they ship.

If it was ever solved, it was always at a task level and if it had room and engineers to pressure, maybe at the agent level but rarely. even rarer at the harness level. As the system develops, its inference choices should develop with it. I don't think every team should have to build and maintain that process and stack themselves. We are building OpenMerit to solve this. In the Mission of optimum inference for all.

#### What optimum means

Optimum depends on the work. We need to know what counts as success, how reliably it must be delivered and the customer's constraints on cost, latency and operation.

A cheaper model that needs repeated attempts may make the completed job more expensive. A stronger model may add cost without improving the result. We need to account for the whole workflow, including anything a person has to fix.

The range of models matters here. There are frontier models from leading labs, general-purpose open-weight models, fine-tuned and distilled variants on Hugging Face, and specialists for coding, retrieval, vision and speech. Jev, by TypeSafe, is designed for fast structured decisions. Its recent release shows there is demand for a different breed of system-one models. Smaller models can run task-specific programs optimised through tools such as DSPy. An agent may have a place for several of these. We want OpenMerit to assess all of them on the work they can actually do, to allocate as it required.

The right deployment could use a direct API from the lab, a router, an inference cloud or a customer-operated model. It could combine them. A company using only commercial APIs should get a complete product. So should one operating entirely within its own environment.

Hardware is equally part of the decision. For customer-operated deployments, we need to account for available compute and memory, concurrent workloads and the cost of loading or swapping models. With managed APIs, we work with measurable outcomes and the constraints the provider exposes.

Local models, open weights and fine-tunes extend the possibilities. We have no preference for moving customers towards them. If the industry the customer operates in demands sovereignty then it should be able to, without sacrificing the intelligence spread.

Better allocation also matters beyond the bill. Where a smaller configuration meets the requirements and the freed capacity can be reused, the same resources can support more work. That is part of what I mean by distributing intelligence.

#### What we are building

There's no end-to-end product or platform clarity at the moment, but on a broader spectrum, you could place OpenMerit as infrastructure for assessing, benchmarking, selecting, assigning and maintaining all model choices within your harness.

It operates at task, agent and harness levels. An assignment should suit the individual task while accounting for the agent's overall result. Across a harness, those choices have to work within shared budgets and capacity.

To get there, OpenMerit first needs to establish which options the customer can use. It should then coordinate comparisons on representative work using their success criteria. Production evidence tells us how the current configuration behaves. It does not establish how an untested alternative would perform.

After deployment, OpenMerit should check whether the expected improvement happened and decide where further investigation is worthwhile. Keeping the current assignment is a valid decision.

The interface should be agent-native. A harness should be able to request a comparison and retrieve an assignment with its evidence programmatically. Within the customer's permissions, OpenMerit should coordinate validated changes through the existing infrastructure, then retain or reverse them based on the results.

We will remain harness-agnostic. The customer's harness owns execution and coordination. Its providers and serving systems run inference. We integrate with its observability and evaluation tools. We will not build those products ourselves as much as we can, and production traffic will not have to pass through us to fulfil the task, but sure can control the traffic based on the evidence.

#### A continuing research problem

Most of the components are still very nascent and will increasingly need newer ways of operating as models become increasingly intelligent and the compute becomes increasingly efficient. Hence we see OpenMerit as a research lab as much as a product company.

To zoom out, we see optimum inference as a long-term research and deployment effort. There is no final configuration we can find, hand over and consider the problem solved.

We need better methods for deciding how much evidence an assignment requires and when that evidence needs updating. Testing every option is expensive. Testing too little can leave us maintaining a poor decision. OpenMerit should spend its testing budget where additional evidence is likely to be useful.

We also need to understand how individual choices affect the complete outcome. A model that performs well on one step may leave the next step with harder work. Several assignments that look sensible separately may compete for the same compute.

These are some of the questions we will have to study in production. Deployment will expose cases our experiments missed and show us which improvements were worth pursuing. That experience should inform the next investigation and the methods we build.

OpenMerit should support this work throughout a system's creation, iteration and ongoing operation.

#### Where we start

Our first customers are engineering and AI teams running repeatable production workflows with measurable outcomes and meaningful inference costs or capacity constraints.

One way to think about it goes like this. A developer or their coding agent connects one workflow. OpenMerit establishes a baseline, compares eligible alternatives and returns a decision they can act on. They keep using it because maintaining that assignment is useful, then connect more work.

The first line of product combines L1, organisation-wide understanding, with L2, repeatable workflows. Individual workflows provide the evidence for a wider view of which models are assigned where, why those choices were made and which ones deserve reassessment and swapping.

L3, adaptive agents, is the longer-term research direction. Agents may revise their plans or create subagents while working. We want to support inference decisions during that execution without taking over the harness's responsibility.

L2 should support a business on its own. It also gives us production experience for the harder questions ahead.

#### A separate company, not a feature

We want OpenMerit to follow the customer's work across whichever models and infrastructure are appropriate.

A customer should be able to change providers, introduce a fine-tune or replace a harness without rebuilding how they make model decisions. Some evidence will need to be revalidated. The history of what they tried and why they changed should remain useful.

That continuing responsibility is substantial enough to build a company around. We intend to earn it through the quality of our decisions and the maintenance we remove from the customer's team.

We are thinking of building an open-core, with hosted and customer-operated options, and charge for continuous assessment and decision management. We will not mark up inference.

#### We need to prove

Our evaluations have to reflect the customer's actual work. We should begin with representative examples and usable success criteria, and limit autonomous changes to decisions the evidence supports. Where the criteria are inadequate, we need to identify that before automating the wrong objective.

Our own costs belong in the calculation. Comparisons consume resources. Switching can introduce failures and maintenance. OpenMerit needs to recognise when an apparent improvement is too small to pursue.

We also need dependable integrations. We should start with a narrow set and make them work well before extending our coverage. Supporting different infrastructure does not require supporting everything immediately.

The standard is a measurable improvement after accounting for testing, switching and running OpenMerit. Depending on the workload, that means better outcomes within the same budget, lower total cost at the required quality or more completed work with available capacity.

#### What is already here in some shape or form

There are useful tools here, including ones that already make model decisions. OpenRouter's Auto Router selects models for incoming requests. Portkey's gateway supports conditional routing, fallbacks and controlled testing of new models in production. Not Diamond lets teams train routers on their own data and evaluation criteria, with quality, cost and latency preferences.

Langfuse helps teams compare changes through evaluation scores, cost, latency and individual failures. Braintrust supports experiments and continuous production evaluation, including bringing production examples back into testing. These tools already help teams investigate and improve their systems.

Many of these capabilities overlap with parts of what we want to explore. They are also components we expect to work with.

We consider optimum inference far from solved. A system needs to determine when the evidence behind an assignment is no longer enough, which alternatives deserve testing and whether a change will improve the completed work after its costs are included. It needs to maintain that process across changes to its tasks, models and infrastructure.

OpenMerit exists to take on that continuing responsibility. The tools for an investigation should be available to the harness, along with the means to act on the result. The customer should not inherit a permanent engineering project to keep it all working.

#### Path ahead

We want teams to know when the strongest model is worth paying for, when an inexpensive alternative is sufficient and when a different deployment would let them do more.

We want those decisions to become part of what a system can maintain for itself. Its engineers should be able to define the work and its constraints without inheriting a permanent job of reconsidering every model assignment.

How much more useful work can we make possible with the intelligence and compute available to us?

---

**Additional Reading**

1. [**"The Shift from Models to Compound AI Systems"**](https://bair.berkeley.edu/blog/2024/02/18/compound-ai-systems/) — Matei Zaharia et al., BAIR. (February 18, 2024)
2. [**"DSPy: Program, Don't Prompt"**](https://dspy.ai/current/) — DSPy / Stanford NLP.
3. [**"Optimas: Optimizing Compound AI Systems with Globally Aligned Local Rewards"**](https://optimas.stanford.edu/) — Shirley Wu et al., arXiv. (February 9, 2026)
4. [**"AI Agents That Matter"**](https://arxiv.org/abs/2407.01502) — Sayash Kapoor, Benedikt Stroebl, Zachary S. Siegel, Nitya Nadgir, and Arvind Narayanan, arXiv. (July 1, 2024)
5. [**"Training a Custom Router"**](https://docs.notdiamond.ai/docs/router-training-quickstart) — Not Diamond.
6. [**"Auto Router — Intelligent Model Selection"**](https://openrouter.ai/docs/guides/routing/routers/auto-router) — OpenRouter.
7. [**"AI Gateway"**](https://portkey.ai/docs/product/ai-gateway) — Portkey.
8. [**"Compare Experiments"**](https://langfuse.com/docs/evaluation/experiments/compare-experiments) — Langfuse.
9. [**"Evaluate Systematically"**](https://www.braintrust.dev/docs/evaluate) — Braintrust.
10. [**"Introducing System One Models & Jev"**](https://typesafe.ai/blog/introducing-system-one-models-and-jev) — Diogo Almeida, TypeSafe AI. (September 15, 2026)