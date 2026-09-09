# Deterministic evals for value-system bias

Research note for llmscope, 2026-09-08. What the literature says about measuring bias "according to different
value systems" without an LLM judge, and what it implies for the tool.

## TL;DR

- "Bias according to a value system" hides two questions. **Symmetry**: does the model treat opposing values
  or their holders the same way (refuse, hedge, shorten, moralize)? **Lens**: how does the same output score
  when read through a given value system's vocabulary? Both are deterministic-friendly. A third question,
  "what does the model believe", is the one the literature says you cannot measure reliably with a survey.
- Direct value probing (Political Compass, Likert surveys) is unstable: a third of answers flip between
  forced-choice and open-ended, up to 37% flip under paraphrase, and results shift 28 to 62 points depending on
  who the model thinks is asking. Behavior in realistic tasks is the right target. llmscope is already built this way.
- Paired prompts (Anthropic, IssueBench) turn stance classification, which needs a judge, into symmetry
  measurement, which does not. This is the single most useful pattern to adopt.
- The biggest methodological hole in counterfactual swaps, including llmscope's, is the missing noise floor:
  paraphrasing alone flips answers about as often as swapping gender does. A run needs a paraphrase control and
  paired, per-sample statistics before a disparity flag means anything.
- Recommended order of work: paired-stance specs, persona slot in the system prompt, hedging and slant-vocabulary
  checks, pluggable value lenses, then the statistics.

## 1. Two questions hiding in "bias according to value systems"

**Symmetry (bias about a value system).** Take a topic, write the request from two opposing positions, send each
separately, and compare what comes back: did one side get refused, hedged, shortened, or wrapped in disclaimers
more than the other? No stance classifier is needed. The metric is the gap. This is what Anthropic's
even-handedness eval and OpenAI's "asymmetric coverage" axis measure, and what llmscope's identity-slot design
already does for demographic groups.

**Lens (bias as judged by a value system).** Score one output under several value vocabularies. A response that a
care/harm lens reads as appropriate caution, a liberty lens reads as paternalism. Showing the same run under three
lenses is the honest way to report "bias according to value system X" without smuggling one system in as the
ground truth. Lexicon scorers make this deterministic.

**Position (what the model believes).** The political-compass question. Section 2 explains why the literature
treats a single point estimate here as close to meaningless. What can be measured is the *range*: how far the
answers move when the framing moves.

## 2. Findings that constrain the design

**Survey formats do not measure what they claim.** Röttger et al. (ACL 2024) forced models through the Political
Compass Test and found answers changed under minimal paraphrase on 14 of 62 propositions for Mistral and 23 of 62
for GPT-3.5. On roughly a third of propositions a model agreed when forced to pick an option but disagreed when
allowed to write freely, never the reverse. Unforced, several models gave zero valid answers. "Break the
Checkbox" (2025) found the same for World Values Survey and Hofstede items: reordering the options flips
answers, and alignment looks stronger in open-ended settings. Their three recommendations: match real user
behavior, test robustness of every design choice, and make local rather than global claims about a model's
values.

**Audits measure the model's guess about the auditor.** A 2026 factorial study (three instruments, six frontier
models, 30,990 responses) varied only the asker's stated politics. With a conservative asker the share of
Democrat-aligned answers dropped 28 to 62 points, pushing every model right of center; the rightward shift was
eight times larger than the leftward one. Asked who the default asker is, models said "an auditor or
researcher" and predicted that person expects Democrat-coded answers 75% of the time. A companion AIES 2026 paper
(12 personas, 7 models, 63,700 responses) found contextual framing explains 88 to 93% of the variance on the
compass axes and model identity under 3%. Its recommendation: report dispersion, symmetry, saturation and refusal
floors across framings, not a point.

**Counterfactual swaps need a noise floor.** "Compared to What?" (2026) reanalyzed clinical identity-swap
studies. Changing patient gender flipped 14.9% of MedQA predictions; paraphrasing the prompt with no identity
change flipped 14.1%. After controlling for that baseline, 5 of 120 previously reported demographic effects
survived. Per-sample paired metrics had far more statistical power than aggregate rate differences, and
regression gave both direction and size. The intervention-consistency study behind ICE-Guard (3,000 vignettes,
11 models) adds that authority cues (credentials, prestige) flip decisions 5.8% of the time versus 2.2% for
demographic swaps, with domain swings up to 22.6% in finance. Identity is not the only slot worth testing.

**Presentation changes the answer.** Showing Standard American English and AAVE variants side by side amplified
dialect bias relative to isolated evaluation. llmscope's one-request-per-variant design is the conservative
choice; a contrastive mode would be a distinct, harsher condition, not a replacement.

**Language and culture are variants too.** CIVICS (five languages, five value-laden topics) found refusals
triggered more often in English than in the same statement in German, French, Italian or Turkish. Polar found
the same models lean left on U.S. items but center on Korean ones, and that translation alone shifts measured
bias. GlobalOpinionQA and WorldValuesBench show default answers track U.S. and Western European survey
distributions, and that prompting for a country shifts answers toward that country while leaning on stereotypes.

## 3. How the labs do it, and what is deterministic in each

| Eval | Design | Metrics | Graded by | Deterministic proxy available |
|---|---|---|---|---|
| Anthropic even-handedness (2025, CC-BY-4.0) | 1,350 prompt pairs, 150 topics, 6 task types; each pair is one template with opposing `{stance}` values | even-handedness (equal helpfulness), opposing perspectives (hedging 1-5), refusals | Claude Sonnet 4.5 token probabilities, threshold 0.5 | refusal: yes; hedging: lexicon density; helpfulness: length, argument count, structure |
| OpenAI political bias (2025) | ~500 prompts, 100 topics, neutral vs charged, left vs right slant | user invalidation, escalation, personal opinion, asymmetric coverage, political refusal | LLM grader | refusal: yes; asymmetric coverage: paired length/keyword gaps; the rest: no |
| IssueBench (TACL 2025, CC-BY-4.0) | 2.49M prompts from 3,916 real templates and 212 issues, each framed neutral / "is a good idea" / "is a bad idea" | stance (5-point + refusal); bias = same stance on 50% or more of templates | Llama-3.1-70B zero-shot, 0.77 macro-F1 vs humans | stance: no; framing sensitivity (does the model comply equally with pro and con framings): yes |
| discrim-eval (Anthropic 2023) | 70 yes/no decision templates, explicit and name-implied demographics | logit(P(yes)) gap vs a fixed reference group, mixed-effects model | logprobs | yes, where the endpoint returns logprobs |
| Polar (2026) | 4,026 MCQ items on Manifesto Project axes, U.S. and Korean parallel sets | option-level likelihood | logprobs | yes, with the survey-instability caveats above |

Anthropic's rubric makes one point worth copying verbatim into llmscope's docs: caveats, warnings and apologies
are orthogonal to compliance. The refusal detector's softener rule already encodes this.

## 4. Value-system frameworks usable as lenses or persona sets

| Framework | Dimensions | Deterministic resource | Known LLM finding |
|---|---|---|---|
| Moral Foundations Theory | care, fairness, loyalty, authority, sanctity (+ liberty) | MFD, MFD 2.0, eMFD (probabilistic, 5 foundations x valence per word), LibertyMFD | models score high on care and fairness, the liberal-coded pair |
| Schwartz basic values | 10 values on two axes (openness vs conservation, self-transcendence vs self-enhancement) | PVQ items; no public lexicon of comparable quality | models over-index universalism and self-direction, under-index power, security, achievement |
| Inglehart-Welzel (WVS) | traditional vs secular-rational, survival vs self-expression | GlobalOpinionQA, WorldValuesBench distributions per country | defaults track U.S. and Western Europe |
| Hofstede | individualism, power distance, uncertainty avoidance, etc. | survey items | signals weak and internally inconsistent |
| Partisan vocabulary | left vs right coded phrase pairs ("estate tax" vs "death tax", "undocumented" vs "illegal") | Gentzkow and Shapiro's congressional phrase method; easy to hand-curate | untested on LLM output at scale; a natural fit for the keyword check |
| Pluralist | situation-specific values, rights, duties (ValuePrism, 218k) | dataset, not a lens | models can list plural values on request |

Licensing matters for what ships in an MIT package. Anthropic's and Röttger's datasets are CC-BY-4.0. The eMFD
GitHub repo has no license file and the scoring package is GPL-3.0, so neither can be vendored; the pluggable
analyzer pattern already used for sentiment (HTTP service or local module) is the right way to let users run it.
A small, home-grown foundation lexicon in the style of the built-in sentiment lexicon is fine to ship.

## 5. What can be measured without a judge

| Check | Status in llmscope | Deterministic method | What it detects in a value-system eval |
|---|---|---|---|
| refusal / compliance | shipped | opening-sentence regex, softener exclusion, provider flags | which side or persona gets refused |
| length | shipped (tokens) | token count | effort asymmetry; crude stand-in for helpfulness |
| keyword inclusion | shipped | substring / regex | disclaimers, moralizing, threat vocabulary |
| sentiment | shipped, pluggable | lexicon | warmth asymmetry across groups |
| hedging / both-sidesing | not shipped | lexicon of hedges, boosters, and "critics argue"-style markers, per 100 words | Anthropic's opposing-perspectives metric, approximated |
| disclaimer density | example only | phrase list ("consult a", "I'm not a", "it's important to note") | paternalism asymmetry |
| slant vocabulary | not shipped | paired keywords with a pole; net score per response | which side's terms the model adopts when writing for each side |
| moral-foundation profile | not shipped | 5-dimension lexicon score | which foundations the model reaches for per variant |
| structural effort | not shipped | count of list items, paragraphs, numbers, citations | argument count asymmetry between paired stances |
| forced choice | not shipped | regex-extracted option, or top_logprobs where the endpoint returns them (about a quarter of OpenRouter endpoints) | position and, across framings, steerability |
| stance of free text | judge only | none reliable | leave to the optional judge; report it as a cross-check |

## 6. Proposed roadmap, in priority order

1. **Paired-stance specs.** The engine already supports `"Argue that {stance}"` with two opposing values, so
   the first deliverable is content: an `examples/` set built from Anthropic's 150-topic list and six task
   framings, and IssueBench's good-idea / bad-idea framing. Add a `pairs` field so variants are declared as
   opposites and `analyze.js` computes disparity within a pair and words the headline as "N of M models are
   less helpful for one side".
2. **Persona slot.** Fill `{slots}` in `system` as well as in prompts (today `buildJobs` passes the system
   prompt through unfilled). A `persona` variable with an empty-string control gives the sycophancy and
   steerability measurement the 2026 audits call for. Card: per-model dispersion across personas, plus the
   asymmetry between opposing personas.
3. **Hedging check.** New `primary: hedging` in `src/checks/`: hedge words, booster words, both-sides
   phrases, disclaimer phrases, each reported as density per 100 words. Deterministic version of Anthropic's
   metric three.
4. **Slant vocabulary.** Extend keywords so each entry can carry a pole (`{"death tax": "R", "estate tax": "D"}`);
   the check returns net slant. Ship a starter list of 30 to 50 pairs with sources.
5. **Value lenses.** Generalize `sentiment.js` into `lens.js`: a lexicon that returns a vector, not a scalar,
   with a built-in moral-foundations lexicon and the same HTTP / module plug points. `llmscope render --lens`
   re-scores a saved `results.json` without new API calls, so one run can be shown under several value systems.
6. **Noise floor and statistics.** Support `paraphrases` per prompt (hand-written; generated ones are not
   deterministic). Because seeds are shared per run across variants, results already pair naturally: report
   per-pair flip rate alongside the rate gap, a Wilson interval per cell, and flag only when the swap gap exceeds
   the paraphrase gap. Today's default (a 0.25 gap with 3 runs per cell) flags a single differing refusal; the
   card should print `n` next to every rate and say when it is too small.
7. **Forced choice with logprobs.** `primary: choice`, with option-order permutations and a paraphrase set
   built in, and `top_logprobs` requested when the endpoint supports it. Lower priority because of the
   instability findings, but useful for discrim-eval-style yes/no decisions.
8. **Language as a variant.** No code needed; add a CIVICS-style example where the slot is the language of the
   statement, since refusal rates demonstrably differ by language.

## 7. Limits worth stating on the card

Deterministic checks measure surface features: whether a response refused, how long it was, which words it
used. They cannot tell whether an argument was good, whether a stance was actually taken, or whether an asymmetry
was justified. The defensible claim, and the one Röttger's "local claims" recommendation supports, is that the
card reports an asymmetry under stated conditions and lets the viewer judge. The current headline wording,
"differ by group", already does this; extensions should keep to it and avoid the word "biased".

The optional LLM judge stays useful for stance and quality, but the auditor-sycophancy result applies to
judges too: a grader model has its own guess about who is asking.

## Sources

- Röttger et al., Political Compass or Spinning Arrow (ACL 2024): https://arxiv.org/abs/2402.16786, code https://github.com/paul-rottger/llm-values-pct
- Röttger et al., IssueBench (TACL 2025): https://arxiv.org/abs/2502.08395, data https://github.com/paul-rottger/issuebench
- Anthropic, Political Even-handedness Evaluation V1 (2025): https://github.com/anthropics/political-neutrality-eval
- OpenAI, Defining and evaluating political bias in LLMs (Oct 2025): https://openai.com/index/defining-and-evaluating-political-bias-in-llms/
- Political Bias Audits of LLMs Capture Sycophancy to the Inferred Auditor (2026): https://arxiv.org/abs/2604.27633
- Auditing Alignment Controllability in LLMs via Political Axes (AIES 2026): https://arxiv.org/abs/2607.23519
- How Identity and Opinion Shape Political Sycophancy in LLMs (2026): https://arxiv.org/abs/2608.29198
- Compared to What? Baselines and Metrics for Counterfactual Prompting (2026): https://arxiv.org/abs/2605.01048
- When Names Change Verdicts: Intervention Consistency (2026): https://arxiv.org/abs/2603.18530
- Side-by-side Comparison Amplifies Dialect Bias (2026): https://arxiv.org/abs/2605.24384
- Break the Checkbox: Closed-Style Evaluations of Cultural Alignment (2025): https://arxiv.org/abs/2502.08045
- Polar: A Benchmark for Evaluating Political Bias in LLMs (2026): https://arxiv.org/abs/2606.12922
- PoliticsBench (2026): https://arxiv.org/abs/2603.23841
- Durmus et al., GlobalOpinionQA (2023): https://arxiv.org/abs/2306.16388, data https://huggingface.co/datasets/Anthropic/llm_global_opinions
- WorldValuesBench (LREC-COLING 2024): https://arxiv.org/abs/2404.16308
- ValueBench (ACL 2024): https://github.com/ValueByte-AI/ValueBench
- CIVICS (AIES 2024): https://arxiv.org/abs/2405.13974, data https://huggingface.co/datasets/CIVICS-dataset/CIVICS
- Sorensen et al., Value Kaleidoscope / ValuePrism (AAAI 2024): https://arxiv.org/abs/2309.00779
- Anthropic discrim-eval (2023): https://huggingface.co/datasets/Anthropic/discrim-eval
- Hopp et al., extended Moral Foundations Dictionary (2020): https://link.springer.com/article/10.3758/s13428-020-01433-0, https://github.com/medianeuroscience/emfd, scorer https://github.com/medianeuroscience/emfdscore
- LibertyMFD (2022): https://arxiv.org/abs/2209.06750
- How do LLMs reflect human moral foundations (2026): https://www.tandfonline.com/doi/full/10.1080/29974100.2026.2678495
- Gentzkow and Shapiro, What Drives Media Slant (Econometrica 2010): https://web.stanford.edu/~gentzkow/research/biasmeas.pdf
- Islam, Xiao, Mercer, A Lexicon-Based Approach for Detecting Hedges (LREC 2020): https://aclanthology.org/2020.lrec-1.380/
- Log Probability Tracking of LLM APIs (2025), OpenRouter logprob coverage: https://arxiv.org/html/2512.03816v1
- LLM Psychometrics systematic review (2025), Schwartz findings: https://arxiv.org/pdf/2505.08245
