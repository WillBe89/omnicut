/** Small dependency-free id generator: `<prefix>_<time36><rand>`. */
let counter = 0;

export function makeId(prefix: string): string {
  counter = (counter + 1) % 0xffff;
  const time = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 0xffffff).toString(36);
  const seq = counter.toString(36);
  return `${prefix}_${time}${seq}${rand}`;
}
