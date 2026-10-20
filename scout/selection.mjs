import { choice } from './utils.mjs';

export function validateSelection(value, label = 'modelIds') {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > 100 || value.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9/_.:+-]{0,159}$/.test(id)) || new Set(value).size !== value.length) throw new Error(`${label} must be a unique list of up to 100 catalogue IDs. An empty list selects no models.`);
  return value;
}

export const eligibilityVersion = '1';
export const factKinds = {releasedAt:'date',listedAt:'date'};
export const factLabels = {
  creator:'model creator organization', host:'inference hosting service',
  family:'model family or line, including its parent family', identity:'exact model version or checkpoint',
  contextTokens:'maximum combined input-plus-output context capacity in tokens', releasedAt:'exact model release date',
  listedAt:'catalogue listing date', deployment:'deployment arrangement',
  other:'an additional model specification or endpoint feature beyond creator, host, family, exact model identity, context capacity, release/listing date or deployment',
};
export const factDefinitions = {
  creator: 'The developer/creator organization of the recommended model. A request for a model from a named AI company restricts this attribute, even without the word only. This is distinct from the hosting service or repository owner.',
  host: 'The inference service through which the selected endpoint is accessed.',
  family: 'A named model line, series, sub-family or lineage, narrowing the versions within a creator. Creator alone is not a family restriction. Family membership can include a broader parent explicitly entailed by a supplied family name.',
  identity: 'An exact model/checkpoint name, identifier or version restriction, distinct from a broad family.',
  contextTokens: 'The maximum supported input-plus-output context length of this endpoint, in tokens.',
  releasedAt: 'The release date of the exact model version, distinct from its listing, collection or last-update date.',
  listedAt: 'The date this model was listed by the catalogue service; this is not a release date.',
  deployment: 'The deployment arrangement, such as hosted inference or self-hosted weights.',
  other: 'An explicit model specification or deployment restriction, such as a token-price ceiling, parameter count, availability or endpoint feature, not covered by the other selection attributes. The work to perform (coding, drawing, writing, reasoning or any other task domain) is NOT an additional metadata restriction. An already covered creator, family, model identity, host, date or context condition is NOT an additional restriction.',
};

export function selectionQuestions(vocabulary={}) {
  return [choice('selection_scope','Does the requested recommendation set specify a model creator, model family, model/version, host, capacity, release period or another model specification? Asking which model from a particular organization or named family to use COUNTS as a restriction, without needing the word only. Preferences permitting alternatives, incidental client names and comparison targets do not restrict the set. Explicit permission to use any provider overrides an incidental company mention.',{absent:'The model set is unrestricted; only the work, soft preferences or incidental names are described.',required:'The requested set of models has a creator, family, version, capacity, time or other specification.'}),choice('selection_focus','Which metadata attribute is explicitly restricted by the requested set of models? Choose absent if the request specifies only work to perform, permits any model, or merely mentions a comparison target. Choose the most specific applicable attribute.',{absent:'No hard model-selection restriction.',...factDefinitions}),choice('selection_dependencies','Do alternative acceptable MODEL SETS impose DIFFERENT conditions on multiple metadata attributes? A list of allowed creators with the same other requirements is not a different combination of conditions. This concerns metadata eligibility, not alternatives in the work to perform.',{no:'No alternative eligible model sets are offered.',yes:'Different complete metadata requirement sets are offered as alternatives.'}),choice('selection_time_view','How are model release/listing time restrictions expressed? Ignore timelines of task data, documents, news and events being analyzed.',{none:'No model-metadata time restriction.',absolute_date:'Absolute date boundaries.',elapsed_age:'Elapsed duration or recency, such as an age in days or weeks.',calendar_period:'Named calendar periods, such as the preceding calendar month.',multiple:'Several different time bases apply together.'}),...Object.entries(factLabels).map(([field,title])=>choice(`selection_${field}`,
    `Select the requested ${title} restriction. Ignore the work performed. Preferences allowing alternatives do not restrict models. ${field==='other'?factDefinitions.other:field==='host'?factDefinitions.host:''}`,
    {any:`Any ${title} is allowed.`,filter:`There are model-selection restrictions on ${title}, including bounds, exclusions, alternatives or unlisted values.`,...Object.fromEntries((vocabulary[field]??[]).slice(0,240).map(value=>[String(value),`The request restricts models to ${title}: ${value}.`]))}))];
}

export function selectionIntent(answers) {
  const required=[],preferred=[],hints={};
  const scope=answers.find(a=>a.name==='selection_scope');
  if(scope?.choice==='absent'&&scope.confidence>=.7)return {version:eligibilityVersion,required,preferred,status:'not-needed'};
  const focus=answers.find(a=>a.name==='selection_focus');
  for(const field of Object.keys(factDefinitions)) {
    const a=answers.find(a=>a.name===`selection_${field}`);
    if(!a)continue;
    if(a.choice!=='any'&&a.confidence>=.7&&!required.includes(field))required.push(field);
    if(!['any','filter'].includes(a.choice)&&a.confidence>=.85)hints[field]=a.choice;
  }
  if(focus&&Object.hasOwn(factDefinitions,focus.choice)&&(focus.confidence>=.7||!required.length&&focus.confidence>=.4)&&!required.includes(focus.choice))required.push(focus.choice);
  if(scope?.choice==='required'&&!required.length)required.push('other');
  const dependencies=answers.find(a=>a.name==='selection_dependencies'),time=answers.find(a=>a.name==='selection_time_view');
  return {version:eligibilityVersion,required,preferred,hints,coupled:dependencies?.choice==='yes'||!!dependencies&&dependencies.confidence<.4,timeView:time?.choice??'absolute_date',status:required.length?'pending':'not-needed'};
}
