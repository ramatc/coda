/** The two profile fields a landing card needs to credit a person. */
interface NamedPerson {
  username: string;
  displayName: string;
}

/**
 * How a landing card credits a review author or a list owner: their display
 * name, or their `@username` when it is blank. The API degrades a missing
 * profile to empty strings rather than failing, so this keeps a card from
 * rendering an empty byline (the same fallback `FeedList` uses for actors).
 */
export function displayNameOrHandle(person: NamedPerson): string {
  const name = person.displayName.trim();
  return name.length > 0 ? name : `@${person.username}`;
}
