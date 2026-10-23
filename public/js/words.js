// Session-name words, random id/password generators and input normalisers. No DOM, works in Node.

/** Valid session id: two digits, a verb, a noun. */
export const ID_RE = /^[0-9]{2}-[a-z]{2,20}-[a-z]{2,20}$/;
const ABC = "abcdefghjkmnpqrstuvwxyz23456789"; // no look-alikes: no i, l, o, 0 or 1
const VERBS = "baking bouncing bowling brewing building camping carving chasing cheering climbing coding cooking counting crawling cycling dancing digging diving dozing drawing dreaming drifting drumming fishing flipping floating flying folding gliding giggling glowing grinning hiking hopping humming hunting jogging juggling jumping knitting laughing leaping marching mixing napping painting paddling planting playing plotting racing reading resting roaming rolling rowing running sailing singing skating skiing sledding sliding smiling sneezing snoring sorting spinning splashing sprinting stacking strolling sulking surfing swaying swimming swinging tapping thinking tiptoeing trading travelling tumbling twirling typing waddling waiting walking waltzing wandering waving whistling winking wobbling wrestling yawning yodeling zooming".split(" ");
const NOUNS = "alpacas apes badgers bats bears beavers bees bison camels cats cheetahs chickens clams cobras cows crabs cranes crows deer dingos dogs dolphins donkeys doves ducks eagles eels elephants elks emus falcons ferrets finches flamingos foxes frogs geckos geese gerbils giraffes goats gorillas hamsters hares hawks hedgehogs herons hippos horses hyenas ibises iguanas jackals jaguars kangaroos kiwis koalas lemurs leopards lions lizards llamas lobsters lynxes magpies meerkats moles moose mules newts octopuses otters owls oxen pandas parrots pelicans penguins pigeons pigs ponies puffins pumas quails rabbits ravens rhinos robins salmon seals sharks sheep shrimps skunks sloths snails sparrows squids squirrels storks swans tapirs tigers toads toucans trout turkeys turtles walruses wasps weasels whales wolves wombats yaks zebras".split(" ");

const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

function randomChars(n) {
  let s = '';
  while (s.length < n) for (const x of rand(n)) if (x < 248 && s.length < n) s += ABC[x % 31]; // 248 = 8 * 31, no bias
  return s;
}

function pick(list) { // unbiased random item
  const lim = Math.floor(4294967296 / list.length) * list.length;
  for (;;) { const x = globalThis.crypto.getRandomValues(new Uint32Array(1))[0]; if (x < lim) return list[x % list.length]; }
}

/**
 * Make a random session id like "42-dancing-apes".
 * @returns {string} an id matching ID_RE
 */
export const newSessionId = () => `${pick(Array.from({ length: 90 }, (_, i) => i + 10))}-${pick(VERBS)}-${pick(NOUNS)}`;

/**
 * Make a random 14-character password from the look-alike-free alphabet.
 * @returns {string}
 */
export const newPassword = () => randomChars(14);

/**
 * Normalise a typed session id: trim, lowercase, spaces and underscores become single dashes.
 * @param {string} s
 * @returns {string}
 */
export const normId = (s) => s.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-');

/**
 * Normalise a typed password: drop spaces and dashes, lowercase.
 * @param {string} s
 * @returns {string}
 */
export const normPass = (s) => s.replace(/[\s-]+/g, '').toLowerCase();
