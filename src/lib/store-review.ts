// Where this install can be rated, for the "Rate in the store" row in Settings and the
// one-time card in the popup.
//
// Kesonode is distributed as a local, self-built package (插件版本/), not through the
// upstream project's Chrome Web Store / Firefox Add-ons listings. There is therefore no
// store page of our own to rate: pointing either entry at the upstream listings would
// send a rating for a different extension, under a different maintainer's name.
//
// The API stays so the caller does not need to know why there is no answer. When Kesonode
// gets a listing of its own, add it here keyed on the id that store assigns; until then
// both the Settings row and the popup card stay hidden.

export interface ReviewPage {
  /** The store's own name. A brand, so it is shown as is in every language. */
  store: string;
  url: string;
}

export function reviewPageFor(_extensionId: string): ReviewPage | null {
  return null;
}
