// Explicit semantic-answer fixtures. These helpers never interpret prompt text.
export const allowProfiles = (snapshot, predicate = () => true) => ({ version: '1', status: 'ok', matches: (snapshot.specialistProfiles ?? []).filter(predicate).map(p => ({ profileId: p.id, confidence: .95 })) });
export const semanticAnswers = (questions, choice = 'compatible') => questions.map(q => ({ name: q.name, type: 'choice', confidence: .95, choice: q.name === 'language_required' ? 'yes' : choice }));
