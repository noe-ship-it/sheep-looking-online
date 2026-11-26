// Card definitions shared by server and client. Pure data, no dependencies.

export const COLORS = [
  { id: 'red', name: 'Red', hex: '#e5484d' },
  { id: 'orange', name: 'Orange', hex: '#f76b15' },
  { id: 'yellow', name: 'Yellow', hex: '#f5c518' },
  { id: 'lime', name: 'Lime', hex: '#99d52a' },
  { id: 'green', name: 'Green', hex: '#30a46c' },
  { id: 'mint', name: 'Mint', hex: '#86ead4' },
  { id: 'cyan', name: 'Cyan', hex: '#00a2c7' },
  { id: 'blue', name: 'Blue', hex: '#3e63dd' },
  { id: 'purple', name: 'Purple', hex: '#8e4ec6' },
  { id: 'magenta', name: 'Magenta', hex: '#d6409f' },
  { id: 'pink', name: 'Pink', hex: '#f4a7c8' },
  { id: 'brown', name: 'Brown', hex: '#8d5a3b' },
  { id: 'beige', name: 'Beige', hex: '#e8d3b0' },
  { id: 'grey', name: 'Grey', hex: '#8b8d98' },
  { id: 'black', name: 'Black', hex: '#2b2b2f' },
  { id: 'white', name: 'White', hex: '#f4f4f0' },
];
export const RAINBOW = 'rainbow';

export const ITSLAM_EFFECTS = {
  lure2: { name: 'Lure 2 Sheep', text: 'Winner moves 2 sheep of their choice from the loser\'s field into their own field.' },
  remove2: { name: 'Remove 2 Sheep', text: 'Winner moves 2 sheep of their choice from the loser\'s field to the discard pile.' },
  yoinkHand: { name: 'Yoink Entire Hand', text: 'Winner takes the loser\'s entire hand.' },
  halve2: { name: 'Halve 2 Sheep', text: 'Winner takes a head or butt (plus any modifier) from 2 of the loser\'s sheep. The loser picks up the leftover halves.' },
  recover1: { name: 'Recover 1 Sheep', text: 'Winner plays any valid sheep from the discard pile into their field.' },
};

export const CARD_INFO = {
  head: { name: 'Sheep Head' },
  butt: { name: 'Sheep Butt' },
  paint: { name: 'Paint', text: 'Modifier: combine any colour head with any colour butt.' },
  franken: { name: 'Franken', text: 'Modifier: combine any 2 heads or any 2 butts. Two heads protect your flock from Wolves; two butts protect it from Wheat.' },
  wheat: { name: 'Wheat', text: 'Lure 1 sheep from an opponent\'s field into yours. Blocked by a double-butted frankensheep.' },
  wolf: { name: 'Wolf', text: 'Discard 1 sheep from an opponent\'s field. Blocked by a double-headed frankensheep.' },
  yoink: { name: 'Yoink!', text: 'Blindly steal 2 cards from an opponent\'s hand.' },
  reflip: { name: 'Re-flip', text: 'After a coin flip goes against you: force a new guess and a new flip.' },
  itslam: { name: 'Is That Sheep Looking At Me?', text: 'Max 1 per turn. Target an opponent, guess the coin. Right: you get the effect. Wrong: they use it on you. −3 points each if still in hand at the end.' },
};

/** Build the 54-card deck, as listed in the official Print & Play. `art` = image file in /cards. */
export function buildDeck() {
  const cards = [];
  let n = 0;
  const add = (c) => cards.push({ id: `c${++n}`, ...c });
  for (const col of COLORS) {
    add({ kind: 'head', color: col.id, art: `head-${col.id}` });
    add({ kind: 'butt', color: col.id, art: `butt-${col.id}` });
  }
  for (const v of [1, 2]) {
    add({ kind: 'head', color: RAINBOW, art: `head-rainbow-${v}` });
    add({ kind: 'butt', color: RAINBOW, art: `butt-rainbow-${v}` });
  }
  const counts = { paint: 2, franken: 2, wheat: 3, wolf: 2, yoink: 2, reflip: 2 };
  for (const [kind, k] of Object.entries(counts)) for (let i = 0; i < k; i++) add({ kind, art: kind });
  for (const effect of Object.keys(ITSLAM_EFFECTS)) add({ kind: 'itslam', effect, art: `itslam-${effect}` });
  return cards;
}

export function isHalf(card) {
  return card && (card.kind === 'head' || card.kind === 'butt');
}
export function isModifier(card) {
  return card && (card.kind === 'paint' || card.kind === 'franken');
}

/** Is (a, b, modifier) a valid sheep? */
export function isValidSheep(a, b, modifier = null) {
  if (!isHalf(a) || !isHalf(b) || a.id === b.id) return false;
  if (modifier && !isModifier(modifier)) return false;
  const kinds = [a.kind, b.kind].sort().join('+');
  if (!modifier) return kinds === 'butt+head' && isNaturalMatch(a, b);
  if (modifier.kind === 'paint') return kinds === 'butt+head';
  if (modifier.kind === 'franken') return kinds === 'head+head' || kinds === 'butt+butt';
  return false;
}

/** Head + butt that match without a modifier (same colour, or one is rainbow). */
export function isNaturalMatch(a, b) {
  if (a.kind === b.kind) return false;
  return a.color === b.color || a.color === RAINBOW || b.color === RAINBOW;
}

/** Any sheep made with 2 rainbow cards (including a rainbow frankensheep) is a Full Rainbow Sheep: 2 points. */
export function isFullRainbow(sheep) {
  return sheep.cards.every((c) => c.color === RAINBOW);
}

/** Half Rainbow: an unmodified head + butt where exactly one half is rainbow. */
export function isHalfRainbow(sheep) {
  return !sheep.modifier && sheep.cards.filter((c) => c.color === RAINBOW).length === 1;
}

/** Bodyswap targets: Modified sheep (paint/franken) or Half Rainbow sheep, in any field. */
export function isBodyswappable(sheep) {
  return !!sheep.modifier || isHalfRainbow(sheep);
}

/** A bodyswap must leave a Basic Sheep (same colour head + butt) or a Full Rainbow Sheep behind. */
export function isBasicOrFullRainbow(a, b) {
  if (a.kind === b.kind) return false;
  if (a.color === RAINBOW || b.color === RAINBOW) return a.color === RAINBOW && b.color === RAINBOW;
  return a.color === b.color;
}

/** Can `newCard` replace sheep.cards[idx]? */
export function canBodyswap(sheep, idx, newCard) {
  if (!isHalf(newCard) || !isBodyswappable(sheep) || idx < 0 || idx > 1) return false;
  return isBasicOrFullRainbow(newCard, sheep.cards[1 - idx]);
}

export function sheepPoints(sheep) {
  return isFullRainbow(sheep) ? 2 : 1;
}

export function isDoubleHeadFranken(sheep) {
  return sheep.modifier?.kind === 'franken' && sheep.cards.every((c) => c.kind === 'head');
}
export function isDoubleButtFranken(sheep) {
  return sheep.modifier?.kind === 'franken' && sheep.cards.every((c) => c.kind === 'butt');
}

export function cardLabel(card) {
  if (!card) return '?';
  if (isHalf(card)) {
    const col = card.color === RAINBOW ? 'Rainbow' : COLORS.find((c) => c.id === card.color)?.name;
    return `${col} ${card.kind}`;
  }
  if (card.kind === 'itslam') return `ITSLAM: ${ITSLAM_EFFECTS[card.effect].name}`;
  return CARD_INFO[card.kind].name;
}
